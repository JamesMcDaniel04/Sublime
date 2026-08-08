/**
 * The Code node's Python runner — CPython compiled to WASM (Pyodide).
 *
 * SECURITY BOUNDARY:
 *   - Every invocation gets a fresh worker, interpreter, JS isolate, and
 *     in-memory filesystem. Nothing survives into another user's run.
 *   - Pyodide's `js` module is backed by an empty object, never `globalThis`,
 *     so guest Python cannot reach Node's process/env/modules or host fetch.
 *   - Python receives an explicit minimal environment rather than inheriting
 *     the worker process environment.
 *   - The parent owns the wall-clock deadline and terminates blocked WASM.
 *     V8 heap/stack limits constrain the worker independently of the server.
 *
 * No host objects cross the boundary: input and output are structured-cloned
 * JSON values and logs are bounded inside the worker before being returned.
 */
import { Worker } from 'node:worker_threads'
import type { CodeRunResult } from './run-js'
import {
  CODE_DEFAULT_TIMEOUT_MS,
  CODE_MAX_LOG_LINE_CHARS,
  CODE_MAX_LOG_LINES,
  CODE_MAX_MEMORY_BYTES,
  CODE_MAX_OUTPUT_CHARS,
  CODE_MAX_STACK_BYTES,
} from './run-js'

const PYTHON_STARTUP_TIMEOUT_MS = 30_000

const clampTimeout = (value: number | undefined) =>
  Math.max(50, Math.min(60_000, value ?? CODE_DEFAULT_TIMEOUT_MS))

const PYTHON_HELPERS = `
import json
import textwrap
from pyodide.code import eval_code

def _sublime_dumps(value):
    return json.dumps(value)

def _sublime_run(code, globals):
    body = textwrap.indent(code, "    ") or "    pass"
    eval_code("def _sublime_main():\\n" + body, globals=globals, filename="code-node.py")
    return globals["_sublime_main"]()
`

/**
 * Kept inline so Next/Vercel does not need to deploy a second worker entry.
 * `require.resolve('pyodide')` below keeps the package visible to output-file
 * tracing; the resolved entry is passed in rather than resolved from eval.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { pathToFileURL } = require('node:url')

const send = (message) => parentPort.postMessage(message)

function pythonErrorSummary(message) {
  const lines = String(message).trimEnd().split('\\n')
  const start = lines.findIndex((line) => line.includes('File "code-node.py"') || line.includes('File "<exec>"'))
  return (start >= 0 ? lines.slice(start) : lines.slice(-3)).join('\\n')
}

function jsonError(reason) {
  return reason === 'too-large'
    ? 'Code returned too large a result (over ' + Math.round(workerData.maxOutputChars / 1000) + 'k characters). Return a summary or fewer fields.'
    : 'Code must return JSON-serializable data (no functions, classes, or cycles).'
}

void (async () => {
  let run
  let globals
  let value
  try {
    const { loadPyodide } = await import(pathToFileURL(workerData.pyodideEntry).href)
    const pyodide = await loadPyodide({
      // The default is globalThis, which exposes process.env and fetch. An
      // empty null-prototype bridge makes `import js` harmless by design.
      jsglobals: Object.freeze(Object.create(null)),
      env: { HOME: '/home/pyodide', LANG: 'C.UTF-8' },
      stdout: () => undefined,
      stderr: () => undefined,
    })
    const lines = []
    let dropped = 0
    const pushLog = (line) => {
      if (lines.length >= workerData.maxLogLines) {
        dropped += 1
        return
      }
      const text = String(line)
      lines.push(text.length > workerData.maxLogLineChars
        ? text.slice(0, workerData.maxLogLineChars) + '… (truncated)'
        : text)
    }
    const logs = () => dropped > 0
      ? [...lines, '… ' + dropped + ' more line' + (dropped === 1 ? '' : 's') + ' not shown']
      : lines
    pyodide.setStdout({ batched: pushLog })
    pyodide.setStderr({ batched: pushLog })
    pyodide.runPython(workerData.helpers)
    globals = pyodide.toPy({
      _items: workerData.items,
      ...(workerData.hasItem ? { _item: workerData.item } : {}),
    })
    run = pyodide.globals.get('_sublime_run')
    value = run(workerData.code, globals)
    const dumps = pyodide.globals.get('_sublime_dumps')
    let text
    try {
      text = dumps(value)
    } finally {
      dumps.destroy()
    }
    if (text.length > workerData.maxOutputChars) {
      send({ type: 'result', result: { ok: false, error: jsonError('too-large'), logs: logs() } })
      return
    }
    send({ type: 'result', result: { ok: true, output: JSON.parse(text), logs: logs() } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const unserializable = message.includes('JSONDecodeError') || message.includes('not JSON serializable')
    send({
      type: 'result',
      result: {
        ok: false,
        error: unserializable ? jsonError('unserializable') : pythonErrorSummary(message),
        logs: [],
      },
    })
  } finally {
    try { value && typeof value.destroy === 'function' && value.destroy() } catch {}
    try { run && run.destroy() } catch {}
    try { globals && globals.destroy() } catch {}
  }
})()
`

export async function runPython(params: {
  code: string
  items: unknown[]
  item?: unknown
  timeoutMs?: number
}): Promise<CodeRunResult> {
  const timeoutMs = clampTimeout(params.timeoutMs)
  let pyodideEntry: string
  try {
    pyodideEntry = require.resolve('pyodide')
  } catch (error) {
    return {
      ok: false,
      error: `Python runtime failed to start: ${error instanceof Error ? error.message : String(error)}`,
      logs: [],
    }
  }

  return new Promise<CodeRunResult>((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        pyodideEntry,
        helpers: PYTHON_HELPERS,
        code: params.code,
        items: structuredClone(params.items),
        item: params.item === undefined ? null : structuredClone(params.item),
        hasItem: params.item !== undefined,
        maxLogLines: CODE_MAX_LOG_LINES,
        maxLogLineChars: CODE_MAX_LOG_LINE_CHARS,
        maxOutputChars: CODE_MAX_OUTPUT_CHARS,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: Math.ceil(CODE_MAX_MEMORY_BYTES / 1024 / 1024),
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: Math.max(1, Math.ceil(CODE_MAX_STACK_BYTES / 1024 / 1024)),
      },
    })
    let settled = false
    let executionTimer: NodeJS.Timeout | null = null
    const startupTimer = setTimeout(() => finish({
      ok: false,
      error: 'Python runtime failed to start within 30 seconds.',
      logs: [],
    }), PYTHON_STARTUP_TIMEOUT_MS)

    function finish(result: CodeRunResult) {
      if (settled) return
      settled = true
      clearTimeout(startupTimer)
      if (executionTimer) clearTimeout(executionTimer)
      worker.terminate().catch(() => undefined)
      resolve(result)
    }

    // Pyodide initialization happens before user code. Start the user deadline
    // on the first worker message; current workers return only a final result,
    // so the startup ceiling remains the conservative outer bound as well.
    executionTimer = setTimeout(() => finish({
      ok: false,
      error: `Code timed out after ${timeoutMs}ms.`,
      logs: [],
    }), timeoutMs + PYTHON_STARTUP_TIMEOUT_MS)

    worker.once('message', (message: { type?: string; result?: CodeRunResult }) => {
      if (message?.type === 'result' && message.result) finish(message.result)
      else finish({ ok: false, error: 'Python runtime returned an invalid response.', logs: [] })
    })
    worker.once('error', (error) => finish({ ok: false, error: `Python runtime failed: ${error.message}`, logs: [] }))
    worker.once('exit', (code) => {
      if (!settled) finish({ ok: false, error: `Python runtime stopped unexpectedly (exit ${code}).`, logs: [] })
    })
  })
}
