/**
 * Import the two Sublime-native shapes: the portable `sublime.flow` document
 * (inverse of toPortableFlow) and the builder's plain download
 * ({ name, description, version, graph }).
 *
 * The credentials block is IGNORED BY DESIGN: a foreign trigger secret must
 * never come alive in this workspace — webhook triggers mint a fresh secret
 * at publish, same as a hand-built flow.
 */
import { z } from 'zod'
import { flowGraphSchema, type FlowGraph } from '@/lib/flows/graph'
import { normalizeFlowTrigger, triggerFromGraph, type FlowTrigger } from '@/lib/flows/trigger'
import { PORTABLE_FORMAT, PORTABLE_VERSION } from '@/lib/export/portable'
import { agentHttpToolSchema, MAX_AGENT_HTTP_TOOLS } from '@/lib/agents/http-tools'
import { FlowImportError, type ImportedFlow } from './types'

const portableAgentSchema = z.object({
  ref: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string(),
  goal: z.string().nullable().optional(),
  model: z.string().optional(),
  integrations: z.array(z.string()).default([]),
  httpTools: z.array(agentHttpToolSchema).max(MAX_AGENT_HTTP_TOOLS).optional(),
})

const portableDocSchema = z.object({
  format: z.literal(PORTABLE_FORMAT),
  version: z.number(),
  flow: z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    trigger: z.unknown().optional(),
    graph: z.unknown(),
  }),
  agents: z.array(portableAgentSchema).default([]),
  requirements: z.array(z.string()).default([]),
}).passthrough()

const downloadDocSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().default(''),
  graph: z.unknown(),
}).passthrough()

function parseGraph(raw: unknown): FlowGraph {
  const parsed = flowGraphSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new FlowImportError(
      `The flow definition is not valid: ${issue.path.join('.') || 'graph'} — ${issue.message}`,
      'INVALID_GRAPH',
    )
  }
  return parsed.data
}

function sanitizedTrigger(raw: unknown): FlowTrigger {
  const trigger = normalizeFlowTrigger(raw)
  delete trigger.webhookSecretHash
  delete trigger.webhookSecretEnc
  return trigger
}

export function fromPortableFlow(raw: unknown): ImportedFlow {
  const parsed = portableDocSchema.safeParse(raw)
  if (!parsed.success) {
    throw new FlowImportError('This sublime.flow document is missing required fields.', 'INVALID_GRAPH')
  }
  const doc = parsed.data
  const warnings = [...doc.requirements]
  if (doc.version !== PORTABLE_VERSION) {
    warnings.push(`This export is version ${doc.version}; this workspace understands version ${PORTABLE_VERSION} — imported best-effort.`)
  }
  return {
    name: doc.flow.name,
    description: doc.flow.description,
    trigger: sanitizedTrigger(doc.flow.trigger),
    graph: parseGraph(doc.flow.graph),
    agentsToCreate: doc.agents,
    source: 'sublime-portable',
    warnings,
    stubbedNodes: [],
  }
}

export function fromDownloadedFlow(raw: unknown): ImportedFlow {
  const parsed = downloadDocSchema.safeParse(raw)
  if (!parsed.success) {
    throw new FlowImportError('This flow file is missing its graph.', 'INVALID_GRAPH')
  }
  const graph = parseGraph(parsed.data.graph)
  return {
    name: parsed.data.name ?? 'Imported flow',
    description: parsed.data.description,
    trigger: sanitizedTrigger(triggerFromGraph(graph)),
    graph,
    agentsToCreate: [],
    source: 'sublime-download',
    warnings: [],
    stubbedNodes: [],
  }
}
