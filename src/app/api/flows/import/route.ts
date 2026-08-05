import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { assertAgentCapacity, assertFlowCapacity } from '@/lib/billing/enforce'
import { serializeFlow } from '@/lib/flows/serialize'
import { validateFlowGraph } from '@/lib/flows/validate'
import { inlineLiteralSecretNodes } from '@/lib/flows/inline-auth'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { missingRequiredProviders, resolveGraphToolConnections, TEMPLATE_CONNECTION_PREFIX } from '@/lib/templates/provision-plan'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import { SsrfError } from '@/lib/net/ssrf'
import { detectFlowImportFormat } from '@/lib/import/detect'
import { fromDownloadedFlow, fromPortableFlow } from '@/lib/import/portable'
import { fromN8nWorkflow } from '@/lib/import/n8n'
import { remapAgentRefs, sanitizeImportedGraph } from '@/lib/import/sanitize'
import { fetchImportDocument, MAX_IMPORT_BYTES } from '@/lib/import/fetch-url'
import { FlowImportError, type ImportedFlow } from '@/lib/import/types'

// Strip undefined + narrow to plain JSON for Prisma's InputJsonValue (same
// helper as src/app/api/flows/route.ts).
function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

const bodySchema = z.object({
  /** Raw JSON text — an uploaded file read client-side, or pasted JSON. */
  document: z.string().min(1).max(MAX_IMPORT_BYTES).optional(),
  /** Fetch the JSON server-side (SSRF-guarded). */
  url: z.string().url().max(2048).optional(),
}).refine((body) => Boolean(body.document) !== Boolean(body.url), {
  message: 'Provide exactly one of "document" or "url".',
})

function convert(text: string): ImportedFlow {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new ApiError('That is not valid JSON.', 400, 'INVALID_JSON')
  }
  const format = detectFlowImportFormat(doc)
  try {
    if (format === 'sublime-portable') return fromPortableFlow(doc)
    if (format === 'sublime-download') return fromDownloadedFlow(doc)
    if (format === 'n8n') return fromN8nWorkflow(doc)
  } catch (error) {
    if (error instanceof FlowImportError) throw new ApiError(error.message, 400, error.code)
    throw error
  }
  if (format === 'sublime-agent') {
    throw new ApiError('This file is an agent export, not a flow — import it from the Agents page.', 400, 'AGENT_EXPORT')
  }
  throw new ApiError(
    'Unrecognized file. Supported: a Sublime flow export (sublime.flow), a flow download from the builder, or an n8n workflow.',
    400,
    'UNRECOGNIZED_FORMAT',
  )
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = bodySchema.parse(await request.json())
  let text = body.document ?? ''
  if (body.url) {
    try {
      text = await fetchImportDocument(body.url)
    } catch (error) {
      if (error instanceof SsrfError) throw new ApiError(error.message, 400, 'URL_NOT_ALLOWED')
      throw new ApiError(error instanceof Error ? error.message : 'The URL could not be fetched.', 400, 'URL_FETCH_FAILED')
    }
  }

  const imported = convert(text)
  const warnings = [...imported.warnings]

  const sanitized = sanitizeImportedGraph(imported.graph)
  let graph = sanitized.graph
  warnings.push(...sanitized.warnings)

  // Imported JSON is untrusted input — same literal-secret gate as POST /api/flows.
  if (inlineLiteralSecretNodes(graph).length) {
    throw new ApiError(
      'HTTP authentication secrets must be saved as a private credential before this flow can be saved.',
      400,
      'INLINE_AUTH_SECRET',
    )
  }

  // template:<provider> placeholders: bind what the workspace has, warn about the rest.
  const templateProviders = Array.from(new Set(graph.nodes.flatMap((node) =>
    node.type === 'tool' && node.data.connectionId.startsWith(TEMPLATE_CONNECTION_PREFIX)
      ? [node.data.connectionId.slice(TEMPLATE_CONNECTION_PREFIX.length)] : [],
  )))
  let catalog: Awaited<ReturnType<typeof loadFlowToolCatalog>> | null = null
  if (templateProviders.length) {
    catalog = await loadFlowToolCatalog(auth.organizationId, { userId: auth.dbUser.id, takeTools: 200 }).catch(() => null)
    const missing = catalog ? missingRequiredProviders(templateProviders, catalog) : templateProviders
    if (catalog && missing.length === 0) {
      graph = resolveGraphToolConnections(graph, catalog).graph
    } else {
      warnings.push(`Connect ${missing.join(', ')} and re-select the connection on the affected steps.`)
    }
  }

  await assertFlowCapacity(auth.organizationId)
  for (let i = 0; i < imported.agentsToCreate.length; i += 1) await assertAgentCapacity(auth.organizationId)

  // Draft-stage validation is advisory (publish is the hard gate, same as the
  // create path) — issues land in the report, never block the import.
  warnings.push(...validateFlowGraph(graph, { requireRunnable: false }).issues.map((issue) => issue.message))

  // Agents + flow land atomically: a failed import leaves nothing behind.
  const { flow, createdAgents, clearedRefs } = await prisma.$transaction(async (tx) => {
    const refToId: Record<string, string> = {}
    const createdAgents: Array<{ id: string; title: string }> = []
    for (const agent of imported.agentsToCreate) {
      const created = await tx.agentTask.create({
        data: {
          agentType: 'CUSTOM',
          description: agent.title,
          objective: agent.instructions,
          goal: agent.goal ?? null,
          schedule: { type: 'manual', time: '', cron: '', timezone: 'UTC', isActive: false },
          status: 'ACTIVE',
          visibility: 'private',
          organizationId: auth.organizationId,
          userId: auth.dbUser.id,
          metadata: {
            title: agent.title,
            description: agent.title,
            model: agent.model ?? DEFAULT_AGENT_MODEL,
            integrations: agent.integrations,
            requiredIntegrations: [],
            skills: [], icon: '', allowSubagents: false, subagentIds: [], autoAnswerFromMemory: true,
          },
        },
        select: { id: true },
      })
      refToId[agent.ref] = created.id
      createdAgents.push({ id: created.id, title: agent.title })
    }
    const remapped = remapAgentRefs(graph, refToId)
    const flow = await tx.flow.create({
      data: {
        name: imported.name,
        description: imported.description,
        status: 'DRAFT',
        visibility: 'private',
        trigger: jsonValue(imported.trigger),
        graph: jsonValue(remapped.graph),
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        metadata: { importedFrom: imported.source },
      },
    })
    return { flow, createdAgents, clearedRefs: remapped.clearedRefs }
  })
  for (const ref of clearedRefs) {
    warnings.push(`An agent step referenced an agent (${ref}) that was not in the file — pick one of your agents.`)
  }

  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'flow_created', resourceType: 'flow', resourceId: flow.id,
    context: { name: flow.name, importedFrom: imported.source },
  })

  // Same construction-time integration warning as POST /api/flows.
  const finalGraph = flow.graph as unknown as typeof graph
  const usedConnectionIds = Array.from(new Set(finalGraph.nodes.flatMap((node) =>
    node.type === 'tool' || node.type === 'http' ? [node.data.connectionId] : [],
  ).filter((id): id is string => Boolean(id))))
  let missingIntegrations: Array<{ nodeId: string; connectionId: string }> = []
  if (usedConnectionIds.length) {
    const available = catalog ?? await loadFlowToolCatalog(auth.organizationId, {
      userId: auth.dbUser.id, connectionIds: usedConnectionIds, takeConnections: usedConnectionIds.length,
    }).catch(() => null)
    if (available) {
      const ids = new Set(available.map((connection) => connection.id))
      missingIntegrations = finalGraph.nodes.flatMap((node) =>
        (node.type === 'tool' || node.type === 'http') && node.data.connectionId && !ids.has(node.data.connectionId)
          ? [{ nodeId: node.id, connectionId: node.data.connectionId }] : [],
      )
    }
  }

  return {
    success: true,
    flow: serializeFlow(flow),
    report: {
      source: imported.source,
      warnings,
      stubbedNodes: imported.stubbedNodes,
      missingIntegrations,
      createdAgents,
    },
  }
}, { requires: 'member', rateLimit: { feature: 'flow-import', perUser: 20, windowSeconds: 60 } })
