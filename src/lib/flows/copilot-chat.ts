import { flowGraphSchema } from '@/lib/flows/graph'
import { copilotOpSchema, type CopilotOp } from '@/lib/flows/copilot-ops'
import { normalizeGeneratedFlowGraphInput, repairGeneratedFlowGraph, type FlowCopilotToolCatalog } from '@/lib/flows/copilot'

/**
 * Pure helpers for the conversational copilot chat endpoint: tolerant parsing
 * of the model's {message, opsJson} structured reply, and sanitization of the
 * candidate ops so the route NEVER returns raw unvalidated model output.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Strip a surrounding ```json fence (if any) before JSON.parse. */
function stripFences(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

export type CopilotChatReply = {
  message: string
  /** Raw candidate op objects, NOT yet validated — feed to sanitizeCopilotOps. */
  candidates: unknown[]
  /** True when the model emitted ops we could not read at all (counts as one discard). */
  opsUnreadable: boolean
  /** Raw demo-run payloads, NOT yet validated — feed to sanitizeDemoRun. */
  demoMocksJson?: string
  demoInputJson?: string
}

/**
 * Tolerantly extract {message, candidates} from a structured-output reply
 * shaped as {"message": "...", "opsJson": "[...]"}. Accepts a direct `ops`
 * array too (in case the model ignores the string wrapper), and strips
 * ```json fences from the inner string before parsing. A missing/empty ops
 * payload is a normal no-change reply; an unreadable one sets opsUnreadable.
 */
export function parseCopilotChatReply(raw: string): CopilotChatReply {
  let outer: unknown
  try {
    outer = JSON.parse(stripFences(raw))
  } catch {
    return { message: '', candidates: [], opsUnreadable: true }
  }
  if (!isRecord(outer)) return { message: '', candidates: [], opsUnreadable: true }
  const message = typeof outer.message === 'string' ? outer.message : ''
  // Optional demo-run payloads ride alongside the ops (see sanitizeDemoRun).
  const demo = {
    ...(typeof outer.demoMocksJson === 'string' && outer.demoMocksJson.trim() ? { demoMocksJson: outer.demoMocksJson } : {}),
    ...(typeof outer.demoInputJson === 'string' && outer.demoInputJson.trim() ? { demoInputJson: outer.demoInputJson } : {}),
  }
  if (Array.isArray(outer.ops)) return { message, candidates: outer.ops, opsUnreadable: false, ...demo }
  if (outer.opsJson === undefined) return { message, candidates: [], opsUnreadable: false, ...demo }
  if (typeof outer.opsJson !== 'string') return { message, candidates: [], opsUnreadable: true, ...demo }
  if (!outer.opsJson.trim()) return { message, candidates: [], opsUnreadable: false, ...demo }
  try {
    const parsed = JSON.parse(stripFences(outer.opsJson))
    if (Array.isArray(parsed)) return { message, candidates: parsed, opsUnreadable: false, ...demo }
    // A single op object (not wrapped in an array) is close enough to accept.
    if (isRecord(parsed)) return { message, candidates: [parsed], opsUnreadable: false, ...demo }
    return { message, candidates: [], opsUnreadable: true, ...demo }
  } catch {
    return { message, candidates: [], opsUnreadable: true, ...demo }
  }
}

/** Bounds for a copilot-authored demo-run payload. */
const DEMO_MAX_CHARS = 20_000
const DEMO_MAX_MOCKS = 40

export type CopilotDemoRun = { mockOutputs: Record<string, unknown>; input?: Record<string, unknown> }

/**
 * Validate a copilot-authored demo-run payload: mocks must be an object keyed
 * by node ids that EXIST in the (post-ops) graph — unknown keys are dropped —
 * and the whole payload is size-capped. Returns null when nothing usable
 * remains, so the route never ships an empty or unbounded demo to the client.
 */
export function sanitizeDemoRun(
  demoMocksJson: string | undefined,
  demoInputJson: string | undefined,
  graph: { nodes: Array<{ id: string }> },
): CopilotDemoRun | null {
  if (!demoMocksJson || demoMocksJson.length > DEMO_MAX_CHARS) return null
  let mocks: unknown
  try {
    mocks = JSON.parse(stripFences(demoMocksJson))
  } catch {
    return null
  }
  if (!isRecord(mocks)) return null
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  const mockOutputs: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(mocks)) {
    if (!nodeIds.has(key)) continue
    if (Object.keys(mockOutputs).length >= DEMO_MAX_MOCKS) break
    mockOutputs[key] = value
  }
  if (Object.keys(mockOutputs).length === 0) return null

  let input: Record<string, unknown> | undefined
  if (demoInputJson && demoInputJson.length <= DEMO_MAX_CHARS) {
    try {
      const parsed = JSON.parse(stripFences(demoInputJson))
      if (isRecord(parsed)) input = parsed
    } catch {
      // A bad input payload never sinks the demo — the run just gets no input.
    }
  }
  return { mockOutputs, ...(input ? { input } : {}) }
}

/**
 * Validate every candidate op through copilotOpSchema and, for replace ops,
 * parse + normalize + schema-validate + repair the embedded graphJson, then
 * attach the sanitized result as `op.graph` (the wire schema strips any
 * model-supplied `graph` key, so only this server-attached graph ever exists).
 * Invalid or unrepairable candidates are dropped and counted.
 */
export function sanitizeCopilotOps(
  candidates: unknown[],
  context: { agents: { id: string }[]; toolCatalog: FlowCopilotToolCatalog },
): { ops: CopilotOp[]; discarded: number } {
  const ops: CopilotOp[] = []
  let discarded = 0
  for (const candidate of candidates) {
    const parsed = copilotOpSchema.safeParse(candidate)
    if (!parsed.success) {
      discarded += 1
      continue
    }
    if (parsed.data.op !== 'replace') {
      ops.push(parsed.data as CopilotOp)
      continue
    }
    try {
      const graph = repairGeneratedFlowGraph(
        flowGraphSchema.parse(normalizeGeneratedFlowGraphInput(JSON.parse(stripFences(parsed.data.graphJson)))),
        context,
      )
      // Echo the CANONICAL serialization, not the model's original (possibly
      // fenced, pre-repair) string, so graphJson and graph always agree.
      ops.push({ op: 'replace', graphJson: JSON.stringify(graph), graph })
    } catch {
      discarded += 1
    }
  }
  return { ops, discarded }
}

/** The sentence appended to `message` when any ops were dropped. */
export function discardNotice(count: number): string {
  return ` (I discarded ${count} change${count === 1 ? '' : 's'} that didn't validate.)`
}
