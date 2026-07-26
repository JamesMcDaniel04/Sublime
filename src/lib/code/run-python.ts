/**
 * The Code node's Python runner — CPython compiled to WASM (Pyodide).
 *
 * Architecture:
 *   - ONE interpreter per process, loaded lazily. The load costs seconds; the
 *     BullMQ worker keeps it warm, the serverless test-node route pays it on
 *     cold start only.
 *   - Runs are SERIALIZED through a promise-chain mutex: the interpreter,
 *     its stdout hook, and the interrupt buffer are shared state.
 *   - Each run gets a FRESH globals dict (`pyodide.toPy({...})`), so no
 *     variable, import, or secret ever bleeds from one step's code into
 *     another's — the state-isolation contract the tests pin.
 *
 * TIMEOUTS — the part that is easy to get wrong: Python executes on the Node
 * main thread, so a `while True:` blocks the event loop and no Promise.race
 * timer can ever fire. Enforcement uses Pyodide's interrupt buffer instead:
 * a watchdog `worker_threads` Worker (source passed inline via `eval: true`,
 * so nothing needs bundling) sleeps for the timeout and then writes SIGINT
 * into a SharedArrayBuffer, which the interpreter checks between bytecodes
 * and raises as KeyboardInterrupt. Execution goes through a sync eval_code
 * helper called in OUR JS frame — never runPythonAsync, whose webloop
 * scheduling re-raises an interrupt as an uncatchable second error out of a
 * setTimeout handle (a worker-crashing uncaughtException). Python code is
 * therefore sync-only (no top-level await), matching n8n's Python node.
 *
 * Output contract mirrors run-js: the final expression's value, forced
 * through Python's json.dumps — so a step's output is JSON-serializable by
 * construction and lambdas/objects fail with a clear message.
 */
import { Worker } from 'node:worker_threads'
import type { CodeRunResult } from './run-js'
import { CODE_DEFAULT_TIMEOUT_MS, CODE_MAX_TIMEOUT_MS } from './run-js'

type Pyodide = Awaited<ReturnType<typeof import('pyodide').loadPyodide>>

const SIGINT = 2

const clampTimeout = (value: number | undefined) =>
  Math.max(50, Math.min(CODE_MAX_TIMEOUT_MS, value ?? CODE_DEFAULT_TIMEOUT_MS))

let pyodidePromise: Promise<Pyodide> | null = null
let interruptBuffer: Uint8Array<SharedArrayBuffer> | null = null

async function getPyodide(): Promise<Pyodide> {
  pyodidePromise ??= (async () => {
    const { loadPyodide } = await import('pyodide')
    const pyodide = await loadPyodide()
    interruptBuffer = new Uint8Array(new SharedArrayBuffer(1))
    pyodide.setInterruptBuffer(interruptBuffer)
    // Helpers live in the DEFAULT globals; user code runs with its own
    // globals dict and never sees them. `_sublime_run` matters: eval_code
    // called DIRECTLY from JS executes in our call frame, synchronously —
    // unlike runPythonAsync, which schedules a webloop handle (a JS
    // setTimeout) where a KeyboardInterrupt raises twice: once into our
    // promise and once, uncatchably, out of the handle — an uncaughtException
    // that would crash the worker process. The cost is no top-level `await`
    // in Python code (n8n's Python node is sync-only as well).
    // User code is wrapped in a function, so a top-level `return` works —
    // n8n's Python snippets end in `return _items` and must run unchanged.
    pyodide.runPython(
      'import json\n'
      + 'import textwrap\n'
      + 'from pyodide.code import eval_code\n'
      + 'def _sublime_dumps(value):\n'
      + '    return json.dumps(value)\n'
      + 'def _sublime_run(code, globals):\n'
      + '    body = textwrap.indent(code, "    ") or "    pass"\n'
      + '    eval_code("def _sublime_main():\\n" + body, globals=globals, filename="code-node.py")\n'
      + '    return globals["_sublime_main"]()\n',
    )
    return pyodide
  })()
  return pyodidePromise
}

/** Sleeps off-thread, then raises KeyboardInterrupt in the interpreter. */
const WATCHDOG_SOURCE =
  "const { workerData } = require('node:worker_threads');"
  + 'setTimeout(() => { workerData.buffer[0] = workerData.signal }, workerData.timeoutMs);'

// The mutex: each run chains onto the previous one's completion.
let chain: Promise<unknown> = Promise.resolve()

export async function runPython(params: {
  code: string
  items: unknown[]
  item?: unknown
  timeoutMs?: number
}): Promise<CodeRunResult> {
  const run = chain.then(() => runExclusively(params))
  // The chain must survive a rejected run, or one failure would wedge every
  // Python step that follows it.
  chain = run.catch(() => undefined)
  return run
}

async function runExclusively(params: {
  code: string
  items: unknown[]
  item?: unknown
  timeoutMs?: number
}): Promise<CodeRunResult> {
  const timeoutMs = clampTimeout(params.timeoutMs)
  const logs: string[] = []
  let pyodide: Pyodide
  try {
    pyodide = await getPyodide()
  } catch (error) {
    return { ok: false, error: `Python runtime failed to start: ${error instanceof Error ? error.message : String(error)}`, logs }
  }

  interruptBuffer![0] = 0
  pyodide.setStdout({ batched: (line) => logs.push(line) })
  pyodide.setStderr({ batched: (line) => logs.push(line) })

  const watchdog = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    workerData: { buffer: interruptBuffer, timeoutMs, signal: SIGINT },
  })

  // toPy deep-converts to real Python lists/dicts; this dict IS the run's
  // entire global namespace, discarded afterwards.
  const globals = pyodide.toPy({
    _items: params.items,
    ...(params.item !== undefined ? { _item: params.item } : {}),
  })
  const run = pyodide.globals.get('_sublime_run')
  try {
    // Synchronous single-frame execution — see the _sublime_run note above.
    const value = run(params.code, globals)
    return { ok: true, output: serialize(pyodide, value), logs }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (interruptBuffer![0] !== 0 || message.includes('KeyboardInterrupt')) {
      return { ok: false, error: `Code timed out after ${timeoutMs}ms.`, logs }
    }
    if (message.includes('JSONDecodeError') || message.includes('not JSON serializable')) {
      return { ok: false, error: 'Code must return JSON-serializable data (no functions, classes, or file handles).', logs }
    }
    return { ok: false, error: pythonErrorSummary(message), logs }
  } finally {
    watchdog.terminate().catch(() => undefined)
    run.destroy()
    globals.destroy()
    // Reset stdio so nothing later in the process writes into this run's logs.
    pyodide.setStdout()
    pyodide.setStderr()
  }
}

/** Force the result through json.dumps inside the interpreter. */
function serialize(pyodide: Pyodide, value: unknown): unknown {
  if (value === undefined || value === null) return null
  // Primitives (int/float/str/bool) come back as JS values already.
  if (typeof value !== 'object' && typeof value !== 'function') {
    return value
  }
  const dumps = pyodide.globals.get('_sublime_dumps')
  const proxy = value as { destroy?: () => void }
  try {
    return JSON.parse(dumps(value))
  } catch {
    throw new Error('PythonResult is not JSON serializable')
  } finally {
    dumps.destroy()
    proxy.destroy?.()
  }
}

/**
 * The last lines of a Python traceback carry the story ("ValueError: bad
 * input" plus the offending line); the Pyodide-internal frames above them are
 * noise for a flow author.
 */
function pythonErrorSummary(message: string): string {
  const lines = message.trimEnd().split('\n')
  const start = lines.findIndex((line) => line.includes('File "code-node.py"') || line.includes('File "<exec>"'))
  return (start >= 0 ? lines.slice(start) : lines.slice(-3)).join('\n')
}
