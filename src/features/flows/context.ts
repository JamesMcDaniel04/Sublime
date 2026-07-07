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
}

/** Read a dot-path off the context (e.g. 'trigger.input', 'step.n1.output.score', 'item'). */
export function readPath(ctx: FlowContext, path: string): unknown {
  const parts = path.trim().split('.')
  let cursor: unknown = ctx
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/** Replace `{{path}}` tokens with values from the context. Objects → JSON; missing → ''. */
export function resolveTemplate(template: string, ctx: FlowContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const value = readPath(ctx, path)
    if (value == null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  })
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

/** Evaluate a structured condition against the context. Never runs arbitrary code. */
/** Evaluate a single comparison. Both sides are templated (RHS may be dynamic). */
export function evalClause(clause: { left: string; op: ConditionOp; right: string }, ctx: FlowContext): boolean {
  const leftRaw = resolveTemplate(clause.left, ctx)
  const rightRaw = resolveTemplate(clause.right, ctx)
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
