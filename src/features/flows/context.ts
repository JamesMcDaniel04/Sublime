import type { ConditionOp } from '@/lib/flows/graph'
import { clockToken, CLOCK_ROOTS } from '@/lib/flows/clock-tokens'
import { workspaceVarsToken, WORKSPACE_VAR_ROOT } from '@/lib/flows/workspace-vars'
import { parseSecretRef, SECRETS_ROOT } from '@/lib/secrets/providers'
import { safeRegexTest } from '@/lib/security/safe-regex'
import { pairedItemFor } from '@/lib/flows/paired-item'

/**
 * The evaluation context threaded through a flow run: the trigger input, every
 * completed step's output keyed by node id, and (inside a loop) the current item.
 */
export type FlowContext = {
  trigger: { input: unknown }
  step: Record<string, { output: unknown }>
  // The instant the RUN started, and the flow's IANA timezone. Both feed the
  // `{{now}}`/`{{today}}` roots. Pinning to run start rather than reading the
  // wall clock per token keeps two tokens in one flow agreeing with each
  // other, and keeps a retry writing the same values as the attempt it
  // retries — these land in filenames and idempotency keys. Timezone absent
  // means UTC, deliberately never the server's zone.
  startedAt?: string
  timezone?: string
  // Secrets resolved from an external store, keyed `<provider>.<path>` and
  // read via {{secrets.<provider>.<path>}}. Fetched once per run, so one
  // secret used in ten steps is one call and a rotation mid-run cannot make
  // two steps disagree. These are REAL secret values living in the context,
  // unlike vault credentials (injected at the transport edge, never in the
  // graph) — which is why redactSecrets runs over everything on the way out.
  secrets?: Record<string, string>
  // Workspace constants, read via {{workspace.<key>}}. Loaded once per run.
  // Distinct from `variables` above, which is FLOW-scoped and written by
  // variable steps — see lib/flows/workspace-vars.ts for why the token roots
  // are deliberately not one letter apart.
  workspaceVars?: Record<string, string>
  // Aggregated outputs of the data-bearing nodes that have executed so far,
  // keyed by builder label. Maintained by the interpreter (which knows node
  // types); read via `{{upstream}}` (whole, size-capped) and auto-appended to
  // agent inputs. Absent until the first data-bearing node completes.
  upstream?: Record<string, unknown>
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
  // True anywhere inside a `threadAgent` loop's body — including through
  // nested containers (parallel branches, nested loops, errorShield
  // body/fallback) — even where `thread` itself isn't set (e.g. a parallel
  // branch, which never carries `thread` since concurrent branches can't
  // share one sequential conversation). Gates the Slack-continuation seed
  // (see resolveAgentContinueExecutionId) so an agent reached through a
  // container inside a threaded loop is never hijacked by an unrelated
  // Slack-continuation run. Absent (falsy) outside any threaded loop.
  withinThreadedLoop?: boolean
  // Node-id → friendly display label (as `stepLabelsOf` derives it, matching
  // the builder). Lets a template reference a step by the label the UI shows
  // on token chips — `{{Previous Agent.output.message}}` — instead of only the
  // id-keyed `{{step.<id>.output.message}}` the picker inserts. Absent means
  // label references simply don't resolve (id-keyed tokens are unaffected).
  stepLabels?: Record<string, string>
}

/** Default character budget for the serialized `{{upstream}}` bundle. */
export const MAX_UPSTREAM_CHARS = 20_000

/**
 * Serialize the upstream aggregate for injection into an agent's context,
 * bounding both the total size and each node's share so one large API response
 * can't crowd out the rest or blow the model's window.
 */
export function serializeUpstream(upstream: Record<string, unknown>, maxChars: number = MAX_UPSTREAM_CHARS): string {
  const entries = Object.entries(upstream)
  if (!entries.length) return '{}'
  const perNode = Math.max(500, Math.floor(maxChars / entries.length))
  const capped: Record<string, unknown> = {}
  for (const [label, value] of entries) {
    let text: string
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
    } catch {
      text = String(value)
    }
    // Truncated entries become a marked string; untouched entries keep their
    // structure so `{{upstream}}` stays valid JSON where it fits.
    capped[label] = text.length > perNode ? `${text.slice(0, perNode)}…[truncated]` : value
  }
  let out: string
  try {
    out = JSON.stringify(capped)
  } catch {
    out = '{}'
  }
  return out.length > maxChars ? `${out.slice(0, maxChars)}…[truncated]` : out
}

/** Read a dot-path off the context (e.g. 'trigger.input', 'step.n1.output.score', 'item'). */
export function readPath(ctx: FlowContext, path: string): unknown {
  const parts = path.trim().split('.')
  // Clock roots resolve first: they are reserved like trigger/step/item, so a
  // step labelled "now" cannot shadow them. Without startedAt there is no
  // instant to render, and returning undefined keeps the template renderer
  // from writing the string "undefined" into someone's filename.
  // Reserved before any label lookup: a step labelled "secrets" must not be
  // able to shadow this root, since shadowing it is exactly how a flow would
  // make a secret token resolve to a value it controls.
  //
  // A miss is undefined rather than the path: rendering the path would leak
  // where the secret lives, and rendering "undefined" would send that string
  // somewhere as an API key.
  if (parts[0] === SECRETS_ROOT) {
    const ref = parseSecretRef(path.trim())
    return ref ? ctx.secrets?.[`${ref.provider}.${ref.path}`] : undefined
  }
  if (parts[0] === WORKSPACE_VAR_ROOT) {
    return workspaceVarsToken(path, ctx.workspaceVars ?? {})
  }
  if (CLOCK_ROOTS.has(parts[0])) {
    return ctx.startedAt ? clockToken(path, { startedAt: ctx.startedAt, timezone: ctx.timezone }) : undefined
  }
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
  // `{{upstream}}` (whole) resolves to a size-capped serialization of every
  // data-bearing node's output captured so far. Deeper `upstream.<label>` paths
  // fall through to the generic walk below and read the raw aggregate map.
  if (parts[0] === 'upstream' && parts.length === 1) {
    return serializeUpstream(ctx.upstream ?? {})
  }
  // Node-label root: the builder shows a step's friendly label on token chips,
  // so users hand-write `{{Previous Agent.output.message}}` instead of the
  // id-keyed form the picker inserts. Resolve a leading label to its step when
  // it isn't already a real context root (reserved roots — trigger/step/item/…
  // — always win) and the label belongs to a step that has actually run. The
  // remaining parts then walk the step wrapper exactly like `step.<id>` would,
  // so `<Label>.output.<field>` mirrors `step.<id>.output.<field>`.
  const labeled = resolveLabelRoot(ctx, parts[0])
  if (labeled) {
    // `<Step>.item` is paired-item lineage: the item THAT step produced which
    // corresponds to the one being processed now (n8n's `$('Node').item`).
    // Checked before the generic walk so it cannot be shadowed — and only for
    // the wrapper's own `item`, so a step whose OUTPUT has a field called
    // `item` is still reachable through `<Step>.output.item`.
    if (parts[1] === 'item') {
      const paired = pairedItemFor(ctx.step[labeled], ctx.loop)
      let cursor: unknown = paired
      for (const part of parts.slice(2)) {
        if (cursor == null || typeof cursor !== 'object') return undefined
        cursor = (cursor as Record<string, unknown>)[part]
      }
      return cursor
    }
    let cursor: unknown = ctx.step[labeled]
    for (const part of parts.slice(1)) {
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

/**
 * Map a leading path segment that is a step's display label to that step's id,
 * or undefined when it is a reserved context root, an unknown label, or a step
 * that hasn't run. Matching trims and lower-cases so chip padding / casing
 * never breaks a reference. Scoped to `ctx.step` (executed steps) so a label
 * only resolves to output that exists and collisions favor a real result.
 */
function resolveLabelRoot(ctx: FlowContext, root: string): string | undefined {
  if (!ctx.stepLabels || root in ctx) return undefined
  const target = root.trim().toLowerCase()
  if (!target) return undefined
  return Object.keys(ctx.step).find((nodeId) => (ctx.stepLabels?.[nodeId] ?? '').trim().toLowerCase() === target)
}

/**
 * Small, deterministic expression language for flow mappings. Expressions use
 * `{{= function(arg, ...) }}` and intentionally have no property assignment,
 * imports, constructors, or arbitrary JavaScript execution.
 */
function splitArgs(source: string): string[] {
  const args: string[] = []
  let quote = ''
  let depth = 0
  let start = 0
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) {
      args.push(source.slice(start, i).trim())
      start = i + 1
    }
  }
  const tail = source.slice(start).trim()
  if (tail) args.push(tail)
  return args
}

function expressionValue(source: string, ctx: FlowContext): unknown {
  const value = source.trim()
  if (!value) return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try { return JSON.parse(value.startsWith("'") ? `"${value.slice(1, -1).replace(/"/g, '\\"')}"` : value) } catch { return value.slice(1, -1) }
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try { return resolveTemplateValue(JSON.parse(value), ctx) } catch { return value }
  }
  const call = value.match(/^([a-zA-Z][\w]*)\((.*)\)$/s)
  if (!call) return readPath(ctx, value)
  const args = splitArgs(call[2]).map((arg) => expressionValue(arg, ctx))
  const text = (item: unknown) => item == null ? '' : typeof item === 'object' ? JSON.stringify(item) : String(item)
  const number = (item: unknown) => Number(item ?? 0)
  switch (call[1]) {
    case 'coalesce': return args.find((item) => item !== undefined && item !== null && item !== '') ?? ''
    case 'concat': return args.map(text).join('')
    case 'upper': return text(args[0]).toUpperCase()
    case 'lower': return text(args[0]).toLowerCase()
    case 'trim': return text(args[0]).trim()
    case 'length': return typeof args[0] === 'string' || Array.isArray(args[0]) ? args[0].length : args[0] && typeof args[0] === 'object' ? Object.keys(args[0]).length : 0
    case 'add': return args.reduce((sum: number, item) => sum + number(item), 0)
    case 'subtract': return number(args[0]) - number(args[1])
    case 'multiply': return args.reduce((product: number, item) => product * number(item), 1)
    case 'divide': return number(args[1]) === 0 ? null : number(args[0]) / number(args[1])
    case 'if': return args[0] ? args[1] : args[2]
    case 'json': try { return JSON.parse(text(args[0])) } catch { return null }
    case 'stringify': return JSON.stringify(args[0])
    case 'now': return new Date().toISOString()
    default: return undefined
  }
}

/**
 * A server-only JavaScript expression evaluator, injected by the runtime so
 * `{{js: <expr>}}` tokens run in the QuickJS sandbox. Absent on the client
 * (previews) and in the sync resolvers, where a `js:` token resolves to ''.
 */
export type EvalJsFn = (expression: string, ctx: FlowContext) => Promise<unknown>

/** How a single `{{…}}` token body is classified. */
const JS_TOKEN_PREFIX = 'js:'

/** Resolve ONE token body synchronously. `js:` needs the async path → ''. */
function tokenValueSync(body: string, ctx: FlowContext): unknown {
  const path = body.trim()
  if (path.startsWith(JS_TOKEN_PREFIX)) return ''
  return path.startsWith('=') ? expressionValue(path.slice(1), ctx) : readPath(ctx, path)
}

/** Resolve ONE token body, awaiting the injected JS evaluator for `js:`. */
async function tokenValueAsync(body: string, ctx: FlowContext, evalJs?: EvalJsFn): Promise<unknown> {
  const path = body.trim()
  if (path.startsWith(JS_TOKEN_PREFIX)) {
    if (!evalJs) return ''
    return evalJs(path.slice(JS_TOKEN_PREFIX.length).trim(), ctx)
  }
  return path.startsWith('=') ? expressionValue(path.slice(1), ctx) : readPath(ctx, path)
}

const stringifyToken = (value: unknown): string =>
  value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)

/** Replace `{{path}}` tokens with values from the context. Objects -> JSON; missing -> ''. */
export function resolveTemplate(template: string, ctx: FlowContext): string {
  // Whitespace is trimmed in the callback rather than in the pattern: `\s*`
  // around a lazy `[^{}]+?` overlaps (whitespace matches both), which makes
  // the match super-linear on a long unclosed `{{`. Trimming in JS keeps the
  // same tokens working and the scan linear.
  return template.replace(/\{\{([^{}]+?)\}\}/g, (_match, raw: string) => stringifyToken(tokenValueSync(raw, ctx)))
}

/**
 * Async twin of resolveTemplate: identical for path / `=` mini-expression
 * tokens, but a `{{js: <expr>}}` token is evaluated by the injected QuickJS
 * evaluator. Used only by the flow runtime (server); the client keeps the
 * sync resolver for previews. String.replace can't await, so this scans and
 * reassembles by hand.
 */
export async function resolveTemplateAsync(template: string, ctx: FlowContext, evalJs?: EvalJsFn): Promise<string> {
  if (!template.includes('{{')) return template
  const pattern = /\{\{([^{}]+?)\}\}/g
  const parts: string[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(template)) !== null) {
    parts.push(template.slice(lastIndex, match.index))
    parts.push(stringifyToken(await tokenValueAsync(match[1], ctx, evalJs)))
    lastIndex = match.index + match[0].length
  }
  parts.push(template.slice(lastIndex))
  return parts.join('')
}

/** Resolve templates inside structured values while preserving exact-token objects/arrays. */
export function resolveTemplateValue(value: unknown, ctx: FlowContext): unknown {
  if (typeof value === 'string') {
    // Same linear-scan reasoning as resolveTemplate: trim in JS, not in the pattern.
    const exact = /^\{\{([^{}]+?)\}\}$/.exec(value.trim())
    if (exact) return tokenValueSync(exact[1], ctx) ?? ''
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

/**
 * Async twin of resolveTemplateValue — preserves exact-token structure and
 * evaluates `{{js: …}}` via the injected evaluator. An exact `js:` token keeps
 * the evaluator's native return type (object/number/…), not a stringified copy.
 */
export async function resolveTemplateValueAsync(value: unknown, ctx: FlowContext, evalJs?: EvalJsFn): Promise<unknown> {
  if (typeof value === 'string') {
    const exact = /^\{\{([^{}]+?)\}\}$/.exec(value.trim())
    if (exact) return (await tokenValueAsync(exact[1], ctx, evalJs)) ?? ''
    return resolveTemplateAsync(value, ctx, evalJs)
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) out.push(await resolveTemplateValueAsync(item, ctx, evalJs))
    return out
  }
  if (value && typeof value === 'object') {
    const entries: [string, unknown][] = []
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      entries.push([key, await resolveTemplateValueAsync(item, ctx, evalJs)])
    }
    return Object.fromEntries(entries)
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

/** Compare two already-resolved string operands by op. Shared by sync + async. */
function compareOperands(op: ConditionOp, leftRaw: string, rightRaw: string): boolean {
  switch (op) {
    case 'contains':
      return leftRaw.includes(rightRaw)
    case 'matches':
      // The pattern is templated, so it can arrive from upstream data (webhook
      // payload, LLM output), not just the flow author. safeRegexTest refuses
      // catastrophic-backtracking shapes outright — a regex that hangs here
      // hangs the worker for the life of the run, uninterruptibly.
      return safeRegexTest(rightRaw, leftRaw)
    default: {
      const l = coerce(leftRaw)
      const r = coerce(rightRaw)
      switch (op) {
        case 'eq': return l === r
        case 'neq': return l !== r
        case 'gt': return l > r
        case 'gte': return l >= r
        case 'lt': return l < r
        case 'lte': return l <= r
      }
    }
  }
  return false
}

/** Evaluate a structured condition against the context. Never runs arbitrary code. */
/** Evaluate a single comparison. Both sides are templated (RHS may be dynamic). */
export function evalClause(clause: { left: string; op: ConditionOp; right: string }, ctx: FlowContext): boolean {
  return compareOperands(clause.op, trimOperand(resolveTemplate(clause.left, ctx)), trimOperand(resolveTemplate(clause.right, ctx)))
}

/** Async twin of evalClause — resolves operands (incl. `{{js:}}`) via the evaluator. */
export async function evalClauseAsync(clause: { left: string; op: ConditionOp; right: string }, ctx: FlowContext, evalJs?: EvalJsFn): Promise<boolean> {
  return compareOperands(
    clause.op,
    trimOperand(await resolveTemplateAsync(clause.left, ctx, evalJs)),
    trimOperand(await resolveTemplateAsync(clause.right, ctx, evalJs)),
  )
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

/** Async twin of evalCondition — evaluates each clause with the JS evaluator. */
export async function evalConditionAsync(
  data: {
    match?: 'all' | 'any'
    clauses?: { left: string; op: ConditionOp; right: string }[]
    left?: string
    op?: ConditionOp
    right?: string
  },
  ctx: FlowContext,
  evalJs?: EvalJsFn,
): Promise<boolean> {
  const clauses =
    data.clauses && data.clauses.length
      ? data.clauses
      : data.left !== undefined && data.op && data.right !== undefined
        ? [{ left: data.left, op: data.op, right: data.right }]
        : []
  if (!clauses.length) return false
  const any = (data.match ?? 'all') === 'any'
  for (const clause of clauses) {
    const passed = await evalClauseAsync(clause, ctx, evalJs)
    if (any && passed) return true
    if (!any && !passed) return false
  }
  return !any
}
