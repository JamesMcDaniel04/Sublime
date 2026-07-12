import type { ConditionOp } from '@/lib/flows/graph'

/**
 * The evaluation context threaded through a flow run: the trigger input, every
 * completed step's output keyed by node id, and (inside a loop) the current item.
 */
export type FlowContext = {
  trigger: { input: unknown }
  step: Record<string, { output: unknown }>
  item?: unknown
  // Present inside a loop body: `{{loop.index}}` (0-based) + total count.
  loop?: { index: number; count: number }
  // The flow's typed symbol table, written by variable steps and read via
  // `{{var.<name>}}` tokens. One shared map per run (loop/parallel bodies
  // mutate the same object so writes persist past the container).
  variables?: Record<string, unknown>
  // First-class input node bindings, read via `{{input.<name>}}`. Absent when
  // the flow declares no input node (back-compat: {{trigger.input}} still works).
  input?: Record<string, unknown>
  // Set inside an Error Shield's fallback body: the caught error message,
  // readable via `{{error}}`. Absent outside a shielded fallback.
  error?: string
  // Set inside a threaded loop body (loop.threadAgent): the stable thread key
  // (per loop) + 0-based iteration, so the agent adapter can continue ONE
  // conversation across iterations. Absent in normal (unthreaded) bodies.
  thread?: { key: string; iteration: number }
  // Cumulative loop-nesting path (outermost -> innermost 0-based index),
  // distinct from `loop` (which is scalar/innermost-only, for {{loop.index}}
  // templates). Used ONLY to disambiguate a loop-body node's persisted output
  // across iterations on resume (see completed-key.ts) — absent outside any
  // loop body.
  iterationPath?: number[]
}

/** Read a dot-path off the context (e.g. 'trigger.input', 'step.n1.output.score', 'item'). */
export function readPath(ctx: FlowContext, path: string): unknown {
  const parts = path.trim().split('.')
  // `var.<name>` roots into the variables map; deeper parts walk the value.
  if (parts[0] === 'var') {
    parts.shift()
    let cursor: unknown = ctx.variables ?? {}
    for (const part of parts) {
      if (cursor == null || typeof cursor !== 'object') return undefined
      cursor = (cursor as Record<string, unknown>)[part]
    }
    return cursor
  }
  let cursor: unknown = ctx
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/** Replace `{{path}}` tokens with values from the context. Objects -> JSON; missing -> ''. */
export function resolveTemplate(template: string, ctx: FlowContext): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, path: string) => {
    const value = readPath(ctx, path)
    if (value == null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
}

/** Resolve templates inside structured values while preserving exact-token objects/arrays. */
export function resolveTemplateValue(value: unknown, ctx: FlowContext): unknown {
  if (typeof value === 'string') {
    const exact = value.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/)
    if (exact) return readPath(ctx, exact[1]) ?? ''
    return resolveTemplate(value, ctx)
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplateValue(item, ctx))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveTemplateValue(item, ctx)]),
    )
  }
  return value
}

/** A step's text output that parses as a JSON object/array is exposed structured. */
export function asStructured(output: unknown): unknown {
  if (typeof output !== 'string') return output
  const trimmed = output.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return output
  try {
    return JSON.parse(trimmed)
  } catch {
    return output
  }
}

/** Coerce a string to a number when it looks numeric, so comparisons order correctly. */
function coerce(value: string): number | string {
  const n = Number(value)
  return value.trim() !== '' && !Number.isNaN(n) ? n : value
}

/**
 * Trim resolved string operands before comparison. Chip insertion appends a
 * trailing space (and users hand-type padding), which would break strict
 * comparisons like eq. Non-string operands pass through untouched.
 */
function trimOperand<T>(value: T): T {
  return typeof value === 'string' ? (value.trim() as T) : value
}

/** Evaluate a structured condition against the context. Never runs arbitrary code. */
/** Evaluate a single comparison. Both sides are templated (RHS may be dynamic). */
export function evalClause(clause: { left: string; op: ConditionOp; right: string }, ctx: FlowContext): boolean {
  const leftRaw = trimOperand(resolveTemplate(clause.left, ctx))
  const rightRaw = trimOperand(resolveTemplate(clause.right, ctx))
  const cond = clause
  switch (cond.op) {
    case 'contains':
      return leftRaw.includes(rightRaw)
    case 'matches':
      try {
        return new RegExp(rightRaw).test(leftRaw)
      } catch {
        return false
      }
    default: {
      const l = coerce(leftRaw)
      const r = coerce(rightRaw)
      switch (cond.op) {
        case 'eq':
          return l === r
        case 'neq':
          return l !== r
        case 'gt':
          return l > r
        case 'gte':
          return l >= r
        case 'lt':
          return l < r
        case 'lte':
          return l <= r
      }
    }
  }
  return false
}

/**
 * Evaluate a condition node's data. Multi-criteria: `clauses` combined with
 * `match` (all=AND / any=OR). Falls back to the legacy single left/op/right.
 */
export function evalCondition(
  data: {
    match?: 'all' | 'any'
    clauses?: { left: string; op: ConditionOp; right: string }[]
    left?: string
    op?: ConditionOp
    right?: string
  },
  ctx: FlowContext,
): boolean {
  const clauses =
    data.clauses && data.clauses.length
      ? data.clauses
      : data.left !== undefined && data.op && data.right !== undefined
        ? [{ left: data.left, op: data.op, right: data.right }]
        : []
  if (!clauses.length) return false
  return (data.match ?? 'all') === 'any' ? clauses.some((c) => evalClause(c, ctx)) : clauses.every((c) => evalClause(c, ctx))
}
