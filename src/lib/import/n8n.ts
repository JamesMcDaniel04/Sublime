/**
 * n8n workflow import — the inverse of `toN8nWorkflow` (src/lib/export/n8n.ts).
 *
 * Product call (2026-08-05): core control-flow primitives map 1:1; the long
 * tail of n8n integration nodes (Slack, Gmail, Sheets, …) imports as HTTP
 * request STUBS — label kept, original type + parameters preserved in the
 * step's note — because most of them are API calls anyway. Every stub is
 * reported via `stubbedNodes` so nothing disappears silently.
 *
 * n8n's `connections` map is keyed by node NAME (not id); this converter
 * resolves names back to ids. Its `={{ … }}` expressions do not translate —
 * they are kept verbatim with ONE summary warning (half-translated
 * expressions would be worse than honest untranslated ones).
 */
import { z } from 'zod'
import {
  flowGraphSchema,
  type ConditionClause,
  type ConditionOp,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from '@/lib/flows/graph'
import type { FlowTrigger } from '@/lib/flows/trigger'
import { FlowImportError, type ImportedFlow, type StubbedNode } from './types'

const n8nNodeSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  type: z.string(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  position: z.tuple([z.number(), z.number()]).optional(),
}).passthrough()

const n8nWorkflowSchema = z.object({
  name: z.string().optional(),
  nodes: z.array(n8nNodeSchema),
  connections: z.record(z.string(), z.unknown()).default({}),
}).passthrough()

type N8nNode = z.infer<typeof n8nNodeSchema>

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
const WAIT_UNITS = ['seconds', 'minutes', 'hours', 'days'] as const

/** n8n comparison operations → our ConditionOp; unknown ops don't translate. */
const OP_MAP: Record<string, ConditionOp> = {
  equals: 'eq', notEquals: 'neq',
  larger: 'gt', largerEqual: 'gte', smaller: 'lt', smallerEqual: 'lte',
  gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte',
  contains: 'contains', regex: 'matches',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const asString = (value: unknown): string =>
  value === undefined || value === null ? '' : typeof value === 'string' ? value : String(value)

function baseType(type: string): string {
  return type.replace(/^n8n-nodes-base\./, '')
}

function isTriggerType(type: string): boolean {
  const base = baseType(type)
  return /trigger$/i.test(base) || base === 'webhook' || base === 'cron'
}

function triggerFor(node: N8nNode): FlowTrigger {
  const base = baseType(node.type)
  if (base === 'webhook') return { type: 'webhook' }
  if (base === 'scheduleTrigger' || base === 'cron') return { type: 'schedule' }
  return { type: 'manual' }
}

/** n8n if/filter v2 conditions → our clauses. Untranslatable → flagged. */
function clausesFrom(parameters: Record<string, unknown>): { match: 'all' | 'any'; clauses: ConditionClause[]; complete: boolean } {
  const conditions = isRecord(parameters.conditions) ? parameters.conditions : undefined
  const list = conditions && Array.isArray(conditions.conditions) ? conditions.conditions : []
  const match = conditions?.combinator === 'or' ? 'any' : 'all'
  const clauses: ConditionClause[] = []
  let complete = list.length > 0
  for (const entry of list) {
    if (!isRecord(entry)) { complete = false; continue }
    const operator = isRecord(entry.operator) ? asString(entry.operator.operation) : ''
    const op = OP_MAP[operator]
    if (!op) { complete = false; continue }
    clauses.push({ left: asString(entry.leftValue), op, right: asString(entry.rightValue) })
  }
  return { match, clauses, complete }
}

/** { parameters: [{name, value}] } (n8n header/query editors) → JSON object string. */
function pairsToJson(raw: unknown): string | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.parameters)) return undefined
  const out: Record<string, string> = {}
  for (const pair of raw.parameters) {
    if (isRecord(pair) && pair.name) out[asString(pair.name)] = asString(pair.value)
  }
  return Object.keys(out).length ? JSON.stringify(out) : undefined
}

type Mapped =
  | { kind: 'node'; node: FlowNode; stub?: true }
  | { kind: 'drop' } // merge/noOp/stickyNote — rewire straight through

function mapNode(node: N8nNode, id: string, warnings: string[]): Mapped {
  const p = node.parameters
  const base = baseType(node.type)
  const label = node.name

  if (base === 'stickyNote' || base === 'merge' || base === 'noOp') return { kind: 'drop' }

  if (node.type.includes('n8n-nodes-langchain') || base === 'openAi') {
    warnings.push(`"${label}" was an n8n AI step — bind it to one of your agents or refine its inline prompt.`)
    return {
      kind: 'node',
      node: { id, type: 'agent', data: { agentId: '', label, prompt: asString(p.text ?? p.prompt), input: '' } },
    }
  }

  switch (base) {
    case 'httpRequest': {
      const method = HTTP_METHODS.includes(asString(p.method).toUpperCase() as typeof HTTP_METHODS[number])
        ? (asString(p.method).toUpperCase() as typeof HTTP_METHODS[number]) : 'GET'
      const headers = pairsToJson(p.headerParameters)
      const query = pairsToJson(p.queryParameters)
      const body = asString(p.jsonBody ?? p.body)
      if (p.authentication && p.authentication !== 'none') {
        warnings.push(`"${label}" used n8n credentials — re-enter authentication for this HTTP step.`)
      }
      return {
        kind: 'node',
        node: {
          id, type: 'http',
          data: {
            label, method, url: asString(p.url),
            ...(headers ? { headers, sendHeaders: true } : {}),
            ...(query ? { query, sendQuery: true } : {}),
            ...(body ? { body, sendBody: true } : {}),
          },
        },
      }
    }
    case 'if': {
      const { match, clauses, complete } = clausesFrom(p)
      if (!complete) warnings.push(`"${label}": some conditions did not translate — re-enter them.`)
      return { kind: 'node', node: { id, type: 'condition', data: { label, match, clauses } } }
    }
    case 'filter': {
      const { match, clauses, complete } = clausesFrom(p)
      if (!complete) warnings.push(`"${label}": some conditions did not translate — re-enter them.`)
      return { kind: 'node', node: { id, type: 'filter', data: { label, match, clauses } } }
    }
    case 'switch': {
      const rules = isRecord(p.rules) && Array.isArray(p.rules.values) ? p.rules.values : []
      const cases = rules.map((rule, index) => {
        const conditions = isRecord(rule)
          ? clausesFrom(rule)
          : { clauses: [] as ConditionClause[], complete: false, match: 'all' as const }
        const first = conditions.clauses[0]
        if (!first) warnings.push(`"${label}" case ${index + 1}: the rule did not translate — re-enter it.`)
        return {
          id: `case-${index}`,
          label: isRecord(rule) ? asString(rule.outputKey) || undefined : undefined,
          left: first?.left ?? '', op: first?.op ?? ('eq' as ConditionOp), right: first?.right ?? '',
        }
      })
      return { kind: 'node', node: { id, type: 'switch', data: { label, cases } } }
    }
    case 'code': case 'function': case 'functionItem':
      return {
        kind: 'node',
        node: {
          id, type: 'code',
          data: {
            label,
            language: asString(p.language) === 'python' ? 'python' : 'javascript',
            mode: asString(p.mode) === 'runOnceForEachItem' ? 'eachItem' : 'allItems',
            code: asString(p.jsCode ?? p.pythonCode ?? p.functionCode),
          },
        },
      }
    case 'set': {
      const assignments = isRecord(p.assignments) && Array.isArray(p.assignments.assignments) ? p.assignments.assignments : []
      const fields = assignments.flatMap((entry) =>
        isRecord(entry) && entry.name ? [{ name: asString(entry.name), value: asString(entry.value) }] : [])
      return { kind: 'node', node: { id, type: 'transform', data: { label, fields } } }
    }
    case 'wait': {
      const unit = WAIT_UNITS.includes(asString(p.unit) as typeof WAIT_UNITS[number])
        ? (asString(p.unit) as typeof WAIT_UNITS[number]) : 'seconds'
      const amount = Number(p.amount)
      return { kind: 'node', node: { id, type: 'wait', data: { label, amount: Number.isFinite(amount) && amount >= 0 ? amount : 1, unit } } }
    }
    case 'splitInBatches':
      warnings.push(`"${label}": n8n loop wiring does not translate — open the step and choose what to loop over, then move the looped steps into it.`)
      return { kind: 'node', node: { id, type: 'loop', data: { label, over: '', body: [] } } }
    case 'stopAndError':
      return { kind: 'node', node: { id, type: 'stop', data: { label, reason: asString(p.errorMessage) } } }
    case 'respondToWebhook': {
      const code = Number(p.responseCode)
      return {
        kind: 'node',
        node: {
          id, type: 'respondWebhook',
          data: {
            label,
            statusCode: Number.isInteger(code) && code >= 100 && code <= 599 ? code : 200,
            body: typeof p.responseBody === 'string' ? p.responseBody : p.responseBody === undefined ? undefined : JSON.stringify(p.responseBody),
            bodyMode: 'json',
          },
        },
      }
    }
    case 'executeWorkflow':
      warnings.push(`"${label}" ran another n8n workflow — import that workflow too, then select it in this step.`)
      return { kind: 'node', node: { id, type: 'subflow', data: { label, flowId: '' } } }
    default: {
      // The integration tail: import as an honest HTTP stub. The original
      // type + parameters travel in the note so the API call can be rebuilt.
      const note = `Imported from n8n node "${node.type}". Rebuild this step as the equivalent API request.\nOriginal parameters:\n${JSON.stringify(p, null, 2)}`.slice(0, 4000)
      return {
        kind: 'node', stub: true,
        node: { id, type: 'http', data: { label, note, method: 'GET', url: '' } },
      }
    }
  }
}

export function fromN8nWorkflow(raw: unknown): ImportedFlow {
  const parsed = n8nWorkflowSchema.safeParse(raw)
  if (!parsed.success) throw new FlowImportError('This n8n workflow file is missing its nodes.', 'INVALID_GRAPH')
  const workflow = parsed.data
  const warnings: string[] = []
  const stubbedNodes: StubbedNode[] = []

  // ids: prefer n8n's node id; names resolve connections. Trigger becomes 'trigger'.
  const idByName = new Map<string, string>()
  const usedIds = new Set<string>(['trigger'])
  const triggerNodes = workflow.nodes.filter((node) => isTriggerType(node.type))
  const primaryTrigger: N8nNode | undefined = triggerNodes[0]
  if (triggerNodes.length > 1) {
    warnings.push('The n8n workflow had multiple triggers — they were merged into one.')
  }

  const nodes: FlowNode[] = []
  const dropped = new Set<string>()
  const layout: NonNullable<FlowGraph['layout']> = {}

  for (const node of workflow.nodes) {
    let id: string
    if (node === primaryTrigger) {
      id = 'trigger'
    } else {
      const preferred = node.id && !usedIds.has(node.id)
        ? node.id
        : node.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'step'
      let candidate = preferred
      for (let n = 2; usedIds.has(candidate); n += 1) candidate = `${preferred}-${n}`
      id = candidate
      usedIds.add(id)
    }
    idByName.set(node.name, id)
    if (node.position) layout[id] = { x: Math.round(node.position[0]), y: Math.round(node.position[1]) }

    if (node === primaryTrigger) {
      nodes.push({ id: 'trigger', type: 'trigger', data: { trigger: triggerFor(node) } })
      continue
    }
    if (isTriggerType(node.type)) {
      // Extra triggers merge into the single 'trigger' via drop-and-rewire.
      dropped.add(id)
      continue
    }

    const mapped = mapNode(node, id, warnings)
    if (mapped.kind === 'drop') { dropped.add(id); continue }
    nodes.push(mapped.node)
    if (mapped.stub) stubbedNodes.push({ nodeId: id, label: node.name, originalType: node.type })
  }

  // connections: { "<source name>": { main: [ [ {node,type,index} ] ] } }
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const edges: FlowEdge[] = []
  let edgeSeq = 1
  for (const [sourceName, value] of Object.entries(workflow.connections)) {
    const sourceId = idByName.get(sourceName)
    if (!sourceId) continue
    const main = isRecord(value) && Array.isArray(value.main) ? value.main : []
    main.forEach((bundle, outputIndex) => {
      if (!Array.isArray(bundle)) return
      for (const link of bundle) {
        if (!isRecord(link) || typeof link.node !== 'string') continue
        const targetId = idByName.get(link.node)
        if (!targetId) continue
        const source = nodeById.get(sourceId)
        const branch =
          source?.type === 'condition' ? (outputIndex === 0 ? 'true' : 'false')
          : source?.type === 'switch' ? source.data.cases[outputIndex]?.id ?? 'default'
          : undefined
        edges.push({ id: `e-${edgeSeq++}`, source: sourceId, target: targetId, ...(branch ? { branch } : {}) })
      }
    })
  }

  // Drop-and-rewire merge/noOp/extra-trigger nodes. A dropped node with no
  // incoming edges (an extra trigger) rewires from 'trigger'.
  let liveEdges = edges
  for (const dropId of dropped) {
    const incoming = liveEdges.filter((edge) => edge.target === dropId)
    const outgoing = liveEdges.filter((edge) => edge.source === dropId)
    const sources = incoming.length ? incoming : [{ id: '', source: 'trigger', target: dropId } as FlowEdge]
    const bridged: FlowEdge[] = []
    for (const into of sources) {
      for (const out of outgoing) {
        bridged.push({ id: `e-${edgeSeq++}`, source: into.source, target: out.target, ...(into.branch ? { branch: into.branch } : {}) })
      }
    }
    liveEdges = liveEdges.filter((edge) => edge.source !== dropId && edge.target !== dropId).concat(bridged)
    delete layout[dropId]
  }

  // No trigger in the workflow: prepend a manual one wired to the entry nodes.
  const trigger: FlowTrigger = primaryTrigger ? triggerFor(primaryTrigger) : { type: 'manual' }
  if (!primaryTrigger) {
    nodes.unshift({ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } })
    const hasIncoming = new Set(liveEdges.map((edge) => edge.target))
    for (const node of nodes) {
      if (node.id === 'trigger' || hasIncoming.has(node.id)) continue
      liveEdges.push({ id: `e-${edgeSeq++}`, source: 'trigger', target: node.id })
    }
  }

  // Dedupe identical bridged edges (drop-and-rewire can double up on diamonds).
  const seenEdges = new Set<string>()
  const finalEdges = liveEdges.filter((edge) => {
    const key = `${edge.source}→${edge.target}→${edge.branch ?? ''}`
    if (seenEdges.has(key)) return false
    seenEdges.add(key)
    return true
  })

  const expressionHits = JSON.stringify(workflow.nodes).match(/=\{\{|\$json|\$node\b/g)
  if (expressionHits?.length) {
    warnings.push(`${expressionHits.length} n8n expression reference(s) were kept as-is — rewrite them as {{step.…}} or {{input.…}} references.`)
  }

  const graphParse = flowGraphSchema.safeParse({ nodes, edges: finalEdges, ...(Object.keys(layout).length ? { layout } : {}) })
  if (!graphParse.success) {
    const issue = graphParse.error.issues[0]
    throw new FlowImportError(`Converted n8n workflow failed validation: ${issue.path.join('.')} — ${issue.message}`, 'INVALID_GRAPH')
  }

  return {
    name: workflow.name || 'Imported n8n workflow',
    description: '',
    trigger,
    graph: graphParse.data,
    agentsToCreate: [],
    source: 'n8n',
    warnings,
    stubbedNodes,
  }
}
