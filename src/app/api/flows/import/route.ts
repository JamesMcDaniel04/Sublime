import { Prisma } from '@/generated/prisma/client'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { assertImportCapacity } from '@/lib/billing/enforce'
import { serializeFlow } from '@/lib/flows/serialize'
import { validateFlowGraph } from '@/lib/flows/validate'
import { inlineLiteralSecretNodes, stripInlineLiteralSecrets } from '@/lib/flows/inline-auth'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { missingRequiredProviders, resolveGraphToolConnections, TEMPLATE_CONNECTION_PREFIX } from '@/lib/templates/provision-plan'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'
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
  /**
   * Re-import behavior when a flow with the same name was already imported:
   * unset → 409 ALREADY_IMPORTED; 'update' → replace that flow's definition
   * (agents reused via their importRef tag); 'new' → create a copy anyway.
   */
  mode: z.enum(['new', 'update']).optional(),
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

/** Stable document identity: provider id when present, otherwise a hash of
 * node identity/topology. Unlike name-only matching, two unrelated workflows
 * called "Lead triage" cannot overwrite one another. */
function importIdentity(text: string, imported: ImportedFlow): string {
  const raw = JSON.parse(text) as Record<string, unknown>
  const externalId = typeof raw.id === 'string'
    ? raw.id
    : raw.flow && typeof raw.flow === 'object' && typeof (raw.flow as { id?: unknown }).id === 'string'
      ? String((raw.flow as { id: string }).id)
      : null
  if (externalId) return `${imported.source}:id:${externalId}`
  const rawNodes = Array.isArray(raw.nodes)
    ? raw.nodes
    : raw.graph && typeof raw.graph === 'object' && Array.isArray((raw.graph as { nodes?: unknown }).nodes)
      ? (raw.graph as { nodes: unknown[] }).nodes
      : raw.flow && typeof raw.flow === 'object'
        && (raw.flow as { graph?: unknown }).graph && typeof (raw.flow as { graph: unknown }).graph === 'object'
        && Array.isArray(((raw.flow as { graph: { nodes?: unknown } }).graph).nodes)
          ? (raw.flow as { graph: { nodes: unknown[] } }).graph.nodes
          : []
  const nodes = rawNodes.map((node) => {
    const row = node && typeof node === 'object' ? node as Record<string, unknown> : {}
    return [row.id ?? '', row.type ?? '', row.name ?? '']
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const topology = raw.connections ?? raw.graph ?? (raw.flow as { graph?: unknown } | undefined)?.graph ?? null
  const digest = createHash('sha256')
    .update(JSON.stringify({ source: imported.source, nodes, topology: topology && typeof topology === 'object' ? Object.keys(topology as object).sort() : [] }))
    .digest('hex')
  return `${imported.source}:shape:${digest}`
}

function priorImportQuery(organizationId: string, userId: string, identity: string) {
  return {
    where: {
      organizationId, userId,
      metadata: { path: ['importIdentity'], equals: identity },
    },
    select: { id: true, name: true },
  } as const
}

/** The flow a prior import of this exact external document created. */
function findPriorImport(organizationId: string, userId: string, identity: string) {
  return prisma.flow.findFirst(priorImportQuery(organizationId, userId, identity))
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
  const identity = importIdentity(text, imported)
  const warnings = [...imported.warnings]

  const sanitized = sanitizeImportedGraph(imported.graph)
  let graph = sanitized.graph
  warnings.push(...sanitized.warnings)

  // Imported JSON is untrusted input. Unlike POST /api/flows (which hard-
  // rejects so a user typing a secret is told), a foreign document gets its
  // literal secrets STRIPPED with a per-step warning — the import proceeds
  // and the secret is never persisted. A residual hit after stripping is a
  // bug in the scrubber; fail closed on it.
  const stripped = stripInlineLiteralSecrets(graph)
  graph = stripped.graph
  warnings.push(...stripped.warnings)
  if (inlineLiteralSecretNodes(graph).length) {
    throw new ApiError(
      'Inline secrets must be saved as a workspace credential before this flow can be saved.',
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

  // Sibling flows (multi-trigger n8n workflows split into one flow per
  // trigger) go through the same sanitize/secret pipeline as the primary.
  const siblings = (imported.additionalFlows ?? []).map((flow) => {
    const cleaned = sanitizeImportedGraph(flow.graph)
    const cleanedStripped = stripInlineLiteralSecrets(cleaned.graph)
    if (inlineLiteralSecretNodes(cleanedStripped.graph).length) {
      throw new ApiError(
        'Inline secrets must be saved as a workspace credential before this flow can be saved.',
        400,
        'INLINE_AUTH_SECRET',
      )
    }
    warnings.push(...[...cleaned.warnings, ...cleanedStripped.warnings].map((warning) => `[${flow.name}] ${warning}`))
    return { flow, graph: cleanedStripped.graph }
  })

  // Idempotent re-import: the same document imported twice should not
  // silently duplicate. Without an explicit mode, a prior import 409s so the
  // client can offer "update it" or "create a copy".
  const updateMode = body.mode === 'update'
  if (!body.mode) {
    const prior = await findPriorImport(auth.organizationId, auth.dbUser.id, identity)
    if (prior) {
      throw new ApiError(
        `"${imported.name}" was already imported. Choose whether to update the existing flow or create a copy.`,
        409,
        'ALREADY_IMPORTED',
      )
    }
  }

  // Draft-stage validation is advisory (publish is the hard gate, same as the
  // create path) — issues land in the report, never block the import.
  warnings.push(...validateFlowGraph(graph, { requireRunnable: false }).issues.map((issue) => issue.message))

  // Agents + all flows land atomically: a failed import leaves nothing behind.
  const { flow, createdAgents, clearedRefs, additionalCreated } = await prisma.$transaction(async (tx) => {
    const sources = [imported, ...siblings.map((entry) => entry.flow)]
    const flowExistence = updateMode
      ? await Promise.all(sources.map((source) => tx.flow.findFirst(priorImportQuery(
          auth.organizationId,
          auth.dbUser.id,
          source === imported ? identity : `${identity}:sibling:${source.name}`,
        ))))
      : sources.map(() => null)
    let agentsToCreate = 0
    for (const source of sources) {
      for (const agent of source.agentsToCreate) {
        const importRef = `${source.name}:${agent.ref}`
        const existing = updateMode
          ? await tx.agentTask.findFirst({
              where: { organizationId: auth.organizationId, userId: auth.dbUser.id, metadata: { path: ['importRef'], equals: importRef } },
              select: { id: true },
            })
          : null
        if (!existing) agentsToCreate += 1
      }
    }
    await assertImportCapacity(tx as unknown as Prisma.TransactionClient, auth.organizationId, {
      flows: flowExistence.filter((row) => !row).length,
      agents: agentsToCreate,
    })
    const createdAgents: Array<{ id: string; title: string; integrations: string[] }> = []
    const materializeAgents = async (agents: typeof imported.agentsToCreate, flowName: string): Promise<Record<string, string>> => {
      const refToId: Record<string, string> = {}
      for (const agent of agents) {
        // Stable identity across re-imports: updating the same document
        // updates the same agents instead of duplicating them.
        const importRef = `${flowName}:${agent.ref}`
        const metadata = {
          title: agent.title,
          description: agent.title,
          model: agent.model ?? DEFAULT_AGENT_MODEL,
          integrations: agent.integrations,
          requiredIntegrations: [],
          skills: [], icon: '', allowSubagents: false, subagentIds: [], autoAnswerFromMemory: true,
          importRef,
          ...(agent.httpTools?.length ? { httpTools: agent.httpTools } : {}),
        }
        const existing = updateMode
          ? await tx.agentTask.findFirst({
              where: { organizationId: auth.organizationId, userId: auth.dbUser.id, metadata: { path: ['importRef'], equals: importRef } },
              select: { id: true },
            })
          : null
        if (existing) {
          // updateMany keeps the tenant guard satisfied (org in the where).
          await tx.agentTask.updateMany({
            where: { id: existing.id, organizationId: auth.organizationId },
            data: { description: agent.title, objective: agent.instructions, goal: agent.goal ?? null, metadata },
          })
        }
        const row = existing
          ? existing
          : await tx.agentTask.create({
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
                metadata,
              },
              select: { id: true },
            })
        refToId[agent.ref] = row.id
        createdAgents.push({ id: row.id, title: agent.title, integrations: agent.integrations })
      }
      return refToId
    }
    const createFlowRow = async (source: ImportedFlow, flowGraph: typeof graph, sourceIdentity: string) => {
      const metadata = jsonValue({
        importedFrom: source.source,
        importIdentity: sourceIdentity,
        // Persisted so credential bulk-bind can also happen later, not
        // only in the import dialog's success screen.
        ...(source.credentialGroups?.length ? { importedCredentialGroups: source.credentialGroups } : {}),
      })
      const data = {
        name: source.name,
        description: source.description,
        trigger: jsonValue(source.trigger),
        graph: jsonValue(flowGraph),
        metadata,
      }
      if (updateMode) {
        const prior = await tx.flow.findFirst(priorImportQuery(auth.organizationId, auth.dbUser.id, sourceIdentity))
        if (prior) {
          await tx.flow.updateMany({
            where: { id: prior.id, organizationId: auth.organizationId, userId: auth.dbUser.id },
            data,
          })
          return tx.flow.findFirstOrThrow({ where: { id: prior.id, organizationId: auth.organizationId } })
        }
      }
      const flow = await tx.flow.create({
        data: {
          ...data,
          status: 'DRAFT',
          visibility: 'private',
          organizationId: auth.organizationId,
          userId: auth.dbUser.id,
        },
      })
      return flow
    }
    const writePins = async (flowId: string, pins: Record<string, unknown> | undefined) => {
      if (!pins || !Object.keys(pins).length) return
      await tx.flowNodePin.deleteMany({ where: { flowId, userId: auth.dbUser.id, organizationId: auth.organizationId } })
      await tx.flowNodePin.createMany({
        data: Object.entries(pins).map(([nodeId, output]) => ({
          flowId, nodeId, userId: auth.dbUser.id, organizationId: auth.organizationId, output: jsonValue(output) as object,
        })),
      })
    }

    const refToId = await materializeAgents(imported.agentsToCreate, imported.name)
    const remapped = remapAgentRefs(graph, refToId)
    const flow = await createFlowRow(imported, remapped.graph, identity)
    await writePins(flow.id, imported.pins)

    const additionalCreated: Array<{ id: string; name: string }> = []
    for (const sibling of siblings) {
      const siblingRefs = await materializeAgents(sibling.flow.agentsToCreate, sibling.flow.name)
      const siblingRemapped = remapAgentRefs(sibling.graph, siblingRefs)
      const row = await createFlowRow(sibling.flow, siblingRemapped.graph, `${identity}:sibling:${sibling.flow.name}`)
      await writePins(row.id, sibling.flow.pins)
      additionalCreated.push({ id: row.id, name: row.name })
    }
    return { flow, createdAgents, clearedRefs: remapped.clearedRefs, additionalCreated }
  // The transaction-scoped advisory lock in assertImportCapacity is the
  // serialization primitive. ReadCommitted deliberately takes a fresh
  // snapshot after waiting for that lock; Serializable would retain the
  // pre-lock snapshot and turn an expected plan-limit response into P2034.
  }, { isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 30_000 })
  for (const ref of clearedRefs) {
    warnings.push(`An agent step referenced an agent (${ref}) that was not in the file — pick one of your agents.`)
  }

  // Bind each materialized agent's integrations to live connector rows (same
  // move as template provisioning) — best-effort, never fails the import.
  await Promise.all(createdAgents.map((agent) =>
    syncAgentConnectors(agent.id, auth.organizationId, auth.dbUser.id, agent.integrations).catch(() => undefined),
  ))

  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'flow_created', resourceType: 'flow', resourceId: flow.id,
    context: { name: flow.name, importedFrom: imported.source },
  })
  for (const sibling of additionalCreated) {
    await recordUserEvent({
      organizationId: auth.organizationId, userId: auth.dbUser.id,
      kind: 'flow_created', resourceType: 'flow', resourceId: sibling.id,
      context: { name: sibling.name, importedFrom: imported.source },
    }).catch(() => undefined)
  }

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
      additionalFlows: additionalCreated,
      credentialGroups: imported.credentialGroups ?? [],
    },
  }
}, { requires: 'member', rateLimit: { feature: 'flow-import', perUser: 20, windowSeconds: 60 } })
