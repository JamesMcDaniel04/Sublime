/**
 * n8n export — importable workflow JSON.
 *
 * n8n is the closest structural match to our engine: it is a real DAG of
 * `nodes` plus a `connections` map, so fan-out and fan-in survive the trip
 * intact (unlike a linear tool, where a merge has to be faked).
 *
 * Shape (n8n "import from file/clipboard"):
 *   { name, nodes: [{ parameters, id, name, type, typeVersion, position }],
 *     connections: { "<source name>": { main: [ [ { node, type, index } ] ] } } }
 * n8n keys connections by node NAME, not id, so names must be unique.
 *
 * Honest mapping: n8n has no native equivalent of our agents, so an agent
 * step exports as a RUNNABLE HTTP Request node that calls the agent's live
 * Sublime trigger endpoint (secret filled in by the user) — the imported
 * workflow executes the real agent instead of a dead placeholder. The full
 * instructions still travel in the node's notes so the work stays portable.
 */
import type { PortableFlow } from './portable'
import type { FlowNode } from '@/lib/flows/graph'

type N8nNode = {
  parameters: Record<string, unknown>
  id: string
  name: string
  type: string
  typeVersion: number
  position: [number, number]
  notes?: string
  notesInFlow?: boolean
}

export type N8nWorkflow = {
  name: string
  nodes: N8nNode[]
  connections: Record<string, { main: { node: string; type: 'main'; index: number }[][] }>
  settings: Record<string, unknown>
  meta: { exportedFrom: string; instructions?: string }
}

const labelOf = (node: FlowNode) => (node.data as { label?: string }).label?.trim() || node.type

// ── Reverse expression translation ──────────────────────────────────────────

/** Sublime condition op → n8n if-v2 operator. Inverse of the importer's OP_MAP. */
const OP_TO_N8N: Record<string, { operation: string; numeric?: boolean }> = {
  eq: { operation: 'equals' }, neq: { operation: 'notEquals' },
  gt: { operation: 'larger', numeric: true }, gte: { operation: 'largerEqual', numeric: true },
  lt: { operation: 'smaller', numeric: true }, lte: { operation: 'smallerEqual', numeric: true },
  contains: { operation: 'contains' }, matches: { operation: 'regex' },
}

/** One template token body → an n8n expression body, or null when it has no honest equivalent. */
function tokenToN8n(body: string, nameById: Map<string, string>): string | null {
  const trimmed = body.trim()
  if (trimmed.startsWith('js:')) {
    // Reverse the importer's scope rewrites inside the raw JS expression.
    let expr = trimmed.slice(3).trim()
    let ok = true
    expr = expr.replace(/step\[("(?:[^"\\]|\\.)*")\]/g, (match, idJson: string) => {
      const label = nameById.get(JSON.parse(idJson) as string)
      if (!label) { ok = false; return match }
      return `$node[${JSON.stringify(label)}].json`
    })
    expr = expr.replace(/\btrigger\.input\b/g, '$json').replace(/\bitem\b/g, '$json').replace(/\bvars\./g, '$env.')
    return ok ? expr : null
  }
  const stepMatch = /^step\.([\w-]+)\.output((?:\.[\w$]+|\[\d+\])*)$/.exec(trimmed)
  if (stepMatch) {
    const label = nameById.get(stepMatch[1])
    return label ? `$node[${JSON.stringify(label)}].json${stepMatch[2] ?? ''}` : null
  }
  const triggerMatch = /^trigger\.input((?:\.[\w$]+|\[\d+\])*)$/.exec(trimmed)
  if (triggerMatch) return `$json${triggerMatch[1] ?? ''}`
  const itemMatch = /^item((?:\.[\w$]+|\[\d+\])*)$/.exec(trimmed)
  if (itemMatch) return `$json${itemMatch[1] ?? ''}`
  const varMatch = /^var\.([A-Za-z_]\w*)$/.exec(trimmed)
  if (varMatch) return `$env.${varMatch[1]}`
  const inputMatch = /^input((?:\.[\w$]+|\[\d+\])*)$/.exec(trimmed)
  if (inputMatch) return `$json${inputMatch[1] ?? ''}`
  return null
}

/**
 * Sublime template string → n8n `=`-prefixed expression. All-or-nothing per
 * string (the importer's rule, reversed): if any token has no n8n equivalent
 * ({{upstream}}, {{= …}} mini-language, label refs), the string exports
 * unchanged rather than half-translated.
 */
function toN8nExpression(value: string, nameById: Map<string, string>): string {
  if (!value.includes('{{')) return value
  let allTranslated = true
  let sawToken = false
  const out = value.replace(/\{\{([^{}]+?)\}\}/g, (segment, inner: string) => {
    sawToken = true
    const mapped = tokenToN8n(inner, nameById)
    if (mapped === null) { allTranslated = false; return segment }
    return `{{ ${mapped} }}`
  })
  if (!sawToken || !allTranslated) return value
  return `=${out}`
}

/** Sublime clause → n8n if-v2 condition entry. */
function clauseToN8n(clause: { left: string; op: string; right: string }, nameById: Map<string, string>): Record<string, unknown> {
  const spec = OP_TO_N8N[clause.op] ?? { operation: 'equals' }
  const numeric = Boolean(spec.numeric) && clause.right.trim() !== '' && Number.isFinite(Number(clause.right))
  return {
    leftValue: toN8nExpression(clause.left, nameById),
    rightValue: numeric ? Number(clause.right) : toN8nExpression(clause.right, nameById),
    operator: { type: numeric ? 'number' : 'string', operation: spec.operation },
  }
}

/** {"header":"value"} JSON string → n8n keypair editor shape, values translated. */
function jsonToPairs(raw: unknown, nameById: Map<string, string>): { parameters: Array<{ name: string; value: string }> } | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const parameters = Object.entries(parsed).map(([name, value]) => ({ name, value: toN8nExpression(String(value), nameById) }))
    return parameters.length ? { parameters } : undefined
  } catch {
    return undefined
  }
}

/** Our step → an n8n node type + parameters. */
function mapNode(node: FlowNode, portable: PortableFlow, nameById: Map<string, string>, triggerBaseUrl?: string): { type: string; typeVersion: number; parameters: Record<string, unknown>; notes?: string } {
  const data = node.data as Record<string, unknown>
  const expr = (value: unknown) => toN8nExpression(String(value ?? ''), nameById)
  switch (node.type) {
    case 'agent': {
      const agentId = typeof data.agentId === 'string' ? data.agentId : ''
      if (!triggerBaseUrl || !agentId) break // placeholder fallback below
      // The trigger secret is never exported \u2014 the recipient pastes it in.
      return {
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        parameters: {
          method: 'POST',
          url: `${triggerBaseUrl}/api/agents/${agentId}/trigger`,
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'x-trigger-secret', value: 'REPLACE_WITH_TRIGGER_SECRET' }] },
          sendBody: true,
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify({ input: $json }) }}',
        },
        notes: 'Runs the live Sublime agent. Paste the trigger secret from the agent\u2019s Webhook settings into the x-trigger-secret header.',
      }
    }
    case 'trigger':
      return { type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }
    case 'http': {
      const headers = jsonToPairs(data.headers, nameById)
      const query = jsonToPairs(data.query, nameById)
      return {
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        parameters: {
          method: String(data.method ?? 'GET'),
          url: expr(data.url),
          ...(headers ? { sendHeaders: true, headerParameters: headers } : {}),
          ...(query ? { sendQuery: true, queryParameters: query } : {}),
          ...(data.body ? { sendBody: true, specifyBody: 'json', jsonBody: expr(data.body) } : {}),
        },
        notes: 'Credentials were not exported — add them in n8n.',
      }
    }
    case 'condition':
    case 'filter': {
      const clauses = Array.isArray(data.clauses) ? data.clauses as Array<{ left: string; op: string; right: string }> : []
      // Legacy single-clause shape still travels on old graphs.
      const effective = clauses.length ? clauses : (data.left !== undefined ? [{ left: String(data.left), op: String(data.op ?? 'eq'), right: String(data.right ?? '') }] : [])
      return {
        type: 'n8n-nodes-base.if',
        typeVersion: 2,
        parameters: {
          conditions: {
            combinator: data.match === 'any' ? 'or' : 'and',
            conditions: effective.map((clause) => clauseToN8n(clause, nameById)),
          },
        },
      }
    }
    case 'switch': {
      const cases = Array.isArray(data.cases) ? data.cases as Array<{ id: string; label?: string; left: string; op: string; right: string }> : []
      return {
        type: 'n8n-nodes-base.switch',
        typeVersion: 3.4,
        parameters: {
          rules: {
            values: cases.map((entry, index) => ({
              outputKey: entry.label || `Case ${index + 1}`,
              conditions: { combinator: 'and', conditions: [clauseToN8n(entry, nameById)] },
            })),
          },
          // fallbackOutput is added by the exporter when a default edge exists.
        },
      }
    }
    case 'router':
      return { type: 'n8n-nodes-base.switch', typeVersion: 3, parameters: {}, notes: 'AI-routed branches — n8n has no equivalent; re-enter the cases as rules.' }
    case 'loop':
    case 'repeatUntil':
      return { type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, parameters: {}, notes: 'Steps inside this loop are exported as separate nodes — rewire them into the loop.' }
    case 'wait':
      return { type: 'n8n-nodes-base.wait', typeVersion: 1.1, parameters: { amount: Number(data.amount ?? 1), unit: String(data.unit ?? 'minutes') } }
    case 'transform': {
      const fields = Array.isArray(data.fields) ? data.fields as Array<{ name: string; value: string }> : []
      return {
        type: 'n8n-nodes-base.set',
        typeVersion: 3.4,
        parameters: {
          assignments: {
            assignments: fields.map((field, index) => ({ id: `a-${index}`, name: field.name, value: expr(field.value), type: 'string' })),
          },
        },
      }
    }
    case 'data': {
      const op = String(data.op ?? '')
      if (op === 'parseJson' || op === 'compose') {
        return { type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: { mode: 'raw', jsonOutput: expr(data.input) } }
      }
      return { type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {}, notes: `Data operation "${op}" — rebuild with an n8n data node (its semantics have no single n8n param shape).` }
    }
    case 'stop':
      return { type: 'n8n-nodes-base.stopAndError', typeVersion: 1, parameters: { errorMessage: String(data.reason ?? 'Stopped') } }
    case 'respondWebhook': {
      const bodyMode = String(data.bodyMode ?? 'json')
      const respondWith = bodyMode === 'text' ? 'text' : bodyMode === 'none' ? 'noData' : 'json'
      return {
        type: 'n8n-nodes-base.respondToWebhook',
        typeVersion: 1.1,
        parameters: {
          respondWith,
          ...(respondWith !== 'noData' && data.body ? { responseBody: expr(data.body) } : {}),
          options: { responseCode: Number(data.statusCode ?? 200) },
        },
      }
    }
    default:
      break
  }
  // tool / humanReview / subflow / errorShield / parallel / … (and agents
  // without a trigger URL): no honest n8n equivalent. Keep it visible as a
  // placeholder whose notes carry the work.
  return { type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} }
}

/** Notes for a step n8n cannot reproduce — the instructions travel with it. */
function placeholderNotes(node: FlowNode, portable: PortableFlow): string | undefined {
  if (node.type === 'agent') {
    const ref = (node.data as { agentId?: string }).agentId
    const agent = portable.agents.find((candidate) => candidate.ref === ref)
    if (!agent) return 'AI agent step — the agent definition was unavailable at export.'
    return [
      `AI agent "${agent.title}".`,
      agent.model ? `Model: ${agent.model}` : '',
      agent.integrations.length ? `Needs tools: ${agent.integrations.join(', ')}` : '',
      '',
      'Instructions:',
      agent.instructions,
    ].filter(Boolean).join('\n')
  }
  if (node.type === 'tool') {
    return `Tool call "${(node.data as { toolName?: string }).toolName ?? ''}" — connect the equivalent n8n integration; credentials are never exported.`
  }
  if (node.type === 'humanReview') return 'Human approval step — n8n has no direct equivalent; consider a Wait + form/webhook.'
  if (node.type === 'subflow') return 'Runs another workflow — export that workflow too and use n8n Execute Workflow.'
  if (node.type === 'parallel') return 'Parallel branches — in n8n, wire the branches directly off the previous node; they run concurrently.'
  if (node.type === 'errorShield') return 'Error shield — use n8n Error Trigger / node "continue on fail".'
  return undefined
}

/**
 * Convert a portable export to an n8n workflow. Node NAMES are made unique
 * because n8n's `connections` map is keyed by name — duplicates would silently
 * merge two steps' wiring.
 */
export function toN8nWorkflow(portable: PortableFlow, options: { triggerBaseUrl?: string } = {}): N8nWorkflow {
  const nodes = portable.flow.graph.nodes ?? []
  const edges = portable.flow.graph.edges ?? []
  const layout = portable.flow.graph.layout ?? {}

  const nameById = new Map<string, string>()
  const used = new Set<string>()
  for (const node of nodes) {
    const base = labelOf(node)
    let name = base
    for (let n = 2; used.has(name); n += 1) name = `${base} (${n})`
    used.add(name)
    nameById.set(node.id, name)
  }

  const n8nNodes: N8nNode[] = nodes.map((node, index) => {
    const mapped = mapNode(node, portable, nameById, options.triggerBaseUrl)
    const position = layout[node.id]
    const notes = [placeholderNotes(node, portable), mapped.notes].filter(Boolean).join('\n\n') || undefined
    return {
      parameters: mapped.parameters,
      id: node.id,
      name: nameById.get(node.id)!,
      type: mapped.type,
      typeVersion: mapped.typeVersion,
      // Reuse the canvas layout so the imported workflow looks like the original.
      position: [position ? Math.round(position.x) : index * 220, position ? Math.round(position.y) : 0],
      // Deactivation round-trips: a disabled step exports disabled.
      ...((node.data as { disabled?: boolean }).disabled ? { disabled: true } : {}),
      ...(notes ? { notes, notesInFlow: true } : {}),
    }
  })

  // n8n connections: source name → main[outputIndex] → [{ node: target name }].
  // Branch labels map onto output indexes: condition true/false → 0/1, switch
  // cases → their declared order, a switch default → the extra fallback output.
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const outputIndexFor = (edge: { source: string; branch?: string }): number => {
    const source = nodeById.get(edge.source)
    if (!source) return 0
    if (source.type === 'condition') return edge.branch === 'false' ? 1 : 0
    if (source.type === 'switch') {
      const cases = Array.isArray((source.data as { cases?: unknown }).cases)
        ? (source.data as { cases: Array<{ id: string }> }).cases : []
      if (edge.branch === 'default') return cases.length
      return Math.max(cases.findIndex((entry) => entry.id === edge.branch), 0)
    }
    return 0
  }
  const connections: N8nWorkflow['connections'] = {}
  for (const edge of edges) {
    const source = nameById.get(edge.source)
    const target = nameById.get(edge.target)
    if (!source || !target) continue
    const outputIndex = outputIndexFor(edge)
    connections[source] ??= { main: [] }
    while (connections[source].main.length <= outputIndex) connections[source].main.push([])
    connections[source].main[outputIndex].push({ node: target, type: 'main', index: 0 })
    // A wired default branch needs the switch to declare its fallback output.
    if (edge.branch === 'default' && nodeById.get(edge.source)?.type === 'switch') {
      const exported = n8nNodes.find((candidate) => candidate.id === edge.source)
      if (exported) exported.parameters.fallbackOutput = 'extra'
    }
  }

  return {
    name: portable.flow.name || 'Untitled workflow',
    nodes: n8nNodes,
    connections,
    settings: {},
    meta: {
      exportedFrom: 'Sublime',
      ...(portable.requirements.length ? { instructions: portable.requirements.join(' ') } : {}),
    },
  }
}
