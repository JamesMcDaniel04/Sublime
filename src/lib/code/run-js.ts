/**
 * The Code node's JavaScript runner.
 *
 * Executes user-authored code in a `node:vm` context with a deliberately tiny
 * surface: `items`, `item`, an n8n-style `$input`, `console`, and timers.
 * Inputs are structured-cloned INTO the sandbox and the return value is
 * JSON-round-tripped OUT, so sandbox code can never hold or mutate a live
 * reference to host state, and a step's output is JSON-serializable by
 * construction (it persists to run rows).
 *
 * SECURITY MODEL — same as n8n's Code node: `node:vm` is an isolation
 * convenience, not a hard boundary. Code authors are workspace members, the
 * trust level of self-hosted n8n. Python gets the stronger (WASM) sandbox.
 *
 * Timeouts cover both halves: the synchronous `vm` timeout stops hot loops,
 * and a race stops never-resolving awaits. On an async timeout the promise
 * keeps running in background — same limitation n8n documents.
 */
import vm from 'node:vm'

export type CodeRunResult =
  | { ok: true; output: unknown; logs: string[] }
  | { ok: false; error: string; logs: string[] }

export const CODE_DEFAULT_TIMEOUT_MS = 10_000
export const CODE_MAX_TIMEOUT_MS = 60_000

/**
 * Resource bounds. A step's output is persisted into a run row and its logs
 * are held in memory, so neither may be unbounded — the same discipline the
 * HTTP node applies to a response body (HTTP_MAX_RESPONSE_CHARS).
 *
 * Logs TRUNCATE with a stated tail (a debugging aid is worth keeping in
 * partial form); an oversized OUTPUT is an ERROR rather than a silent trim,
 * because a truncated payload flowing into the next step is far worse than a
 * loud failure.
 */
export const CODE_MAX_LOG_LINES = 1_000
export const CODE_MAX_LOG_LINE_CHARS = 2_000
export const CODE_MAX_OUTPUT_CHARS = 200_000

const clampTimeout = (value: number | undefined) =>
  Math.max(50, Math.min(CODE_MAX_TIMEOUT_MS, value ?? CODE_DEFAULT_TIMEOUT_MS))

const logLine = (args: unknown[]) =>
  args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value) ?? String(value))).join(' ')

/**
 * A bounded log sink. Counts everything it was given so the tail can state
 * how much was dropped, but only ever retains CODE_MAX_LOG_LINES.
 */
export function createLogSink(max = CODE_MAX_LOG_LINES) {
  const lines: string[] = []
  let dropped = 0
  return {
    push(line: string) {
      if (lines.length < max) lines.push(line.length > CODE_MAX_LOG_LINE_CHARS ? `${line.slice(0, CODE_MAX_LOG_LINE_CHARS)}… (truncated)` : line)
      else dropped += 1
    },
    drain(): string[] {
      return dropped > 0 ? [...lines, `… ${dropped} more line${dropped === 1 ? '' : 's'} not shown`] : lines
    },
  }
}

export type JsonSafeResult = { ok: true; value: unknown } | { ok: false; reason: 'unserializable' | 'too-large' }

/** JSON round-trip: the output contract, the size gate, and the reference-severing copy. */
export function toJsonSafe(value: unknown): JsonSafeResult {
  if (value === undefined) return { ok: true, value: undefined }
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    return { ok: false, reason: 'unserializable' }
  }
  // JSON.stringify maps functions/symbols to undefined rather than throwing.
  if (text === undefined) return { ok: false, reason: 'unserializable' }
  if (text.length > CODE_MAX_OUTPUT_CHARS) return { ok: false, reason: 'too-large' }
  return { ok: true, value: JSON.parse(text) }
}

/** The user-facing message for a rejected output, shared by both engines. */
export function jsonSafeError(reason: 'unserializable' | 'too-large'): string {
  return reason === 'too-large'
    ? `Code returned too large a result (over ${Math.round(CODE_MAX_OUTPUT_CHARS / 1000)}k characters). Return a summary or fewer fields.`
    : 'Code must return JSON-serializable data (no functions, classes, or cycles).'
}

export async function runJavaScript(params: {
  code: string
  items: unknown[]
  item?: unknown
  timeoutMs?: number
}): Promise<CodeRunResult> {
  const timeoutMs = clampTimeout(params.timeoutMs)
  const sink = createLogSink()
  const logs = { get value() { return sink.drain() } }
  // Cloned in: sandbox mutations hit a copy, never the interpreter's context.
  const items = structuredClone(params.items)
  const item = params.item === undefined ? undefined : structuredClone(params.item)
  const $input = {
    all: () => items,
    first: () => items[0],
    last: () => items[items.length - 1],
    item,
  }
  const sandbox = {
    items,
    item,
    $input,
    console: {
      log: (...args: unknown[]) => { sink.push(logLine(args)) },
      error: (...args: unknown[]) => { sink.push(logLine(args)) },
      warn: (...args: unknown[]) => { sink.push(logLine(args)) },
    },
    // Timers make backoff-style snippets work; they resolve within the run's
    // own race window so they cannot outlive the timeout accounting.
    setTimeout,
    clearTimeout,
    JSON,
    Math,
    Date,
  }
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })

  let resultPromise: unknown
  try {
    // The async IIFE makes both `return` and top-level `await` legal, matching
    // what the editor's default snippets teach.
    resultPromise = vm.runInContext(`(async () => {\n${params.code}\n})()`, context, {
      timeout: timeoutMs,
      filename: 'code-node.js',
    })
  } catch (error) {
    return { ok: false, error: describeError(error, timeoutMs), logs: logs.value }
  }

  let timer: NodeJS.Timeout | undefined
  try {
    const raced = await Promise.race([
      Promise.resolve(resultPromise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Code timed out after ${timeoutMs}ms.`)), timeoutMs)
      }),
    ])
    const safe = toJsonSafe(raced)
    if (!safe.ok) return { ok: false, error: jsonSafeError(safe.reason), logs: logs.value }
    return { ok: true, output: safe.value ?? null, logs: logs.value }
  } catch (error) {
    return { ok: false, error: describeError(error, timeoutMs), logs: logs.value }
  } finally {
    clearTimeout(timer)
  }
}

function describeError(error: unknown, timeoutMs: number): string {
  // Duck-typed rather than `instanceof Error`: an error thrown inside the vm
  // belongs to the sandbox realm, whose Error is a different intrinsic.
  if (error && typeof error === 'object' && 'message' in error) {
    // node:vm reports its sync timeout as ERR_SCRIPT_EXECUTION_TIMEOUT.
    if ((error as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      return `Code timed out after ${timeoutMs}ms.`
    }
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
