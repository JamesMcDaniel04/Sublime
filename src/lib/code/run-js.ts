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

const clampTimeout = (value: number | undefined) =>
  Math.max(50, Math.min(CODE_MAX_TIMEOUT_MS, value ?? CODE_DEFAULT_TIMEOUT_MS))

const logLine = (args: unknown[]) =>
  args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value) ?? String(value))).join(' ')

/** JSON round-trip: the output contract, and the reference-severing copy. */
function toJsonSafe(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined }
  try {
    const text = JSON.stringify(value)
    // JSON.stringify maps functions/symbols to undefined rather than throwing.
    if (text === undefined) return { ok: false }
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

export async function runJavaScript(params: {
  code: string
  items: unknown[]
  item?: unknown
  timeoutMs?: number
}): Promise<CodeRunResult> {
  const timeoutMs = clampTimeout(params.timeoutMs)
  const logs: string[] = []
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
      log: (...args: unknown[]) => { logs.push(logLine(args)) },
      error: (...args: unknown[]) => { logs.push(logLine(args)) },
      warn: (...args: unknown[]) => { logs.push(logLine(args)) },
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
    return { ok: false, error: describeError(error, timeoutMs), logs }
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
    if (!safe.ok) return { ok: false, error: 'Code must return JSON-serializable data (no functions, classes, or cycles).', logs }
    return { ok: true, output: safe.value ?? null, logs }
  } catch (error) {
    return { ok: false, error: describeError(error, timeoutMs), logs }
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
