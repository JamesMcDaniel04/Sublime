/**
 * The Code node's JavaScript runner.
 *
 * Executes user-authored code inside QuickJS compiled to WebAssembly. The guest
 * has its own heap and JavaScript intrinsics and receives only JSON input plus
 * deliberately bridged console/timer functions. It has no Node `process`,
 * modules, environment, filesystem, network, or references to host objects.
 *
 * A fresh runtime is created for every step. CPU, memory, stack, logs, output,
 * and asynchronous lifetime are all bounded before the result is returned to
 * the flow interpreter.
 */
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten'
import type { QuickJSHandle } from 'quickjs-emscripten'

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
export const CODE_MAX_MEMORY_BYTES = 64 * 1024 * 1024
export const CODE_MAX_STACK_BYTES = 512 * 1024

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
  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(CODE_MAX_MEMORY_BYTES)
  runtime.setMaxStackSize(CODE_MAX_STACK_BYTES)
  const deadline = Date.now() + timeoutMs
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline))
  const vm = runtime.newContext()
  const executePendingJobs = () => {
    const outcome = runtime.executePendingJobs()
    try {
      if (outcome.error) throw new Error(describeQuickJSError(vm.dump(outcome.error), timeoutMs, Date.now() >= deadline))
    } finally {
      outcome.dispose()
    }
  }

  const hostTimers = new Map<number, { timer: NodeJS.Timeout; callback: QuickJSHandle; args: QuickJSHandle[] }>()
  let nextTimerId = 1
  const installFunction = (target: QuickJSHandle, name: string, implementation: (args: QuickJSHandle[]) => QuickJSHandle | void) => {
    const fn = vm.newFunction(name, (...args) => implementation(args))
    vm.setProp(target, name, fn)
    fn.dispose()
  }

  const consoleHandle = vm.newObject()
  for (const name of ['log', 'error', 'warn']) {
    installFunction(consoleHandle, name, (args) => {
      sink.push(logLine(args.map((arg) => {
        try { return vm.dump(arg) } catch { return '[unprintable]' }
      })))
    })
  }
  vm.setProp(vm.global, 'console', consoleHandle)
  consoleHandle.dispose()

  installFunction(vm.global, 'setTimeout', (args) => {
    const callback = args[0]
    if (!callback || vm.typeof(callback) !== 'function') return vm.newNumber(0)
    const delay = args[1] ? Math.max(0, Math.min(timeoutMs, Number(vm.dump(args[1])) || 0)) : 0
    const id = nextTimerId++
    const callbackCopy = callback.dup()
    const argCopies = args.slice(2).map((arg) => arg.dup())
    const timer = setTimeout(() => {
      const entry = hostTimers.get(id)
      if (!entry) return
      hostTimers.delete(id)
      try {
        const called = vm.callFunction(entry.callback, vm.undefined, ...entry.args)
        if (called.error) called.error.dispose()
        else called.value.dispose()
        executePendingJobs()
      } finally {
        entry.callback.dispose()
        entry.args.forEach((arg) => arg.dispose())
      }
    }, delay)
    hostTimers.set(id, { timer, callback: callbackCopy, args: argCopies })
    return vm.newNumber(id)
  })
  installFunction(vm.global, 'clearTimeout', (args) => {
    const id = args[0] ? Number(vm.dump(args[0])) : 0
    const entry = hostTimers.get(id)
    if (entry) {
      clearTimeout(entry.timer)
      entry.callback.dispose()
      entry.args.forEach((arg) => arg.dispose())
      hostTimers.delete(id)
    }
  })

  // This guest promise is captured by the wrapper before user code starts, so
  // replacing globals cannot bypass the asynchronous deadline.
  const deadlinePromise = vm.newPromise()
  installFunction(vm.global, '__sublimeDeadline', () => deadlinePromise.handle)
  const deadlineTimer = setTimeout(() => {
    const error = vm.newError(`Code timed out after ${timeoutMs}ms.`)
    deadlinePromise.reject(error)
    error.dispose()
    executePendingJobs()
  }, timeoutMs)

  const inputJson = JSON.stringify(structuredClone(params.items))
  const itemJson = params.item === undefined ? 'undefined' : JSON.stringify(structuredClone(params.item))
  const wrapped = `
    ((__deadline) => {
      const items = ${inputJson};
      const item = ${itemJson};
      const $input = Object.freeze({
        all: () => items,
        first: () => items[0],
        last: () => items[items.length - 1],
        item,
      });
      return Promise.race([
        (async () => {\n${params.code}\n})(),
        __deadline(),
      ]);
    })(__sublimeDeadline)
  `

  try {
    const evaluated = vm.evalCode(wrapped, 'code-node.js')
    if (evaluated.error) {
      const error = describeQuickJSError(vm.dump(evaluated.error), timeoutMs, Date.now() >= deadline)
      evaluated.error.dispose()
      return { ok: false, error, logs: logs.value }
    }

    const promiseHandle = evaluated.value
    executePendingJobs()
    let resolvedHandle: QuickJSHandle
    while (true) {
      const state = vm.getPromiseState(promiseHandle)
      if (state.type === 'fulfilled') {
        resolvedHandle = state.value
        break
      }
      if (state.type === 'rejected') {
        const error = describeQuickJSError(vm.dump(state.error), timeoutMs, Date.now() >= deadline)
        state.error.dispose()
        promiseHandle.dispose()
        return { ok: false, error, logs: logs.value }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(5, Math.max(1, deadline - Date.now()))))
      executePendingJobs()
    }
    promiseHandle.dispose()
    if (['function', 'symbol'].includes(vm.typeof(resolvedHandle))) {
      resolvedHandle.dispose()
      return { ok: false, error: jsonSafeError('unserializable'), logs: logs.value }
    }
    let output: unknown
    try {
      output = vm.dump(resolvedHandle)
    } catch {
      resolvedHandle.dispose()
      return { ok: false, error: jsonSafeError('unserializable'), logs: logs.value }
    }
    resolvedHandle.dispose()
    const safe = toJsonSafe(output)
    if (!safe.ok) return { ok: false, error: jsonSafeError(safe.reason), logs: logs.value }
    return { ok: true, output: safe.value ?? null, logs: logs.value }
  } catch (error) {
    return { ok: false, error: describeQuickJSError(error, timeoutMs, Date.now() >= deadline), logs: logs.value }
  } finally {
    clearTimeout(deadlineTimer)
    for (const entry of hostTimers.values()) {
      clearTimeout(entry.timer)
      entry.callback.dispose()
      entry.args.forEach((arg) => arg.dispose())
    }
    hostTimers.clear()
    deadlinePromise.dispose()
    vm.dispose()
    runtime.dispose()
  }
}

function describeQuickJSError(error: unknown, timeoutMs: number, timedOut: boolean): string {
  if (timedOut) return `Code timed out after ${timeoutMs}ms.`
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (typeof record.message === 'string') return record.message
  }
  return String(error)
}
