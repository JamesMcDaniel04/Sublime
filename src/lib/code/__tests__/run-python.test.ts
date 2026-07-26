/**
 * The Code node's Python runner (Pyodide — CPython in WASM).
 *
 * The invariants: `_items` / `_item` arrive as real Python structures and the
 * last expression (or `_items`-style assignment) comes back as JSON; state
 * NEVER bleeds between runs (a fresh globals dict per run — two steps sharing
 * the singleton interpreter must not see each other's variables); print()
 * output is captured; and errors surface as Python tracebacks, not host
 * crashes.
 *
 * These tests share one interpreter load (module singleton) — first test pays
 * the WASM start-up, the rest are fast.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPython } from '../run-python'
import { CODE_MAX_LOG_LINES } from '../run-js'

test('returns the returned value — top-level return works, as in n8n snippets', async () => {
  const result = await runPython({ code: 'return 1 + 1', items: [] })
  assert.equal(result.ok && result.output, 2)
})

test('_items carries the input and returns pythonic transforms as JSON', async () => {
  const result = await runPython({
    code: 'for item in _items:\n    item["json"]["my_new_field"] = 1\nreturn _items',
    items: [{ json: { a: 1 } }, { json: { a: 2 } }],
  })
  assert.deepEqual(result.ok && result.output, [
    { json: { a: 1, my_new_field: 1 } },
    { json: { a: 2, my_new_field: 1 } },
  ])
})

test('_item is the current item in eachItem mode', async () => {
  const result = await runPython({
    code: '_item["json"]["double"] = _item["json"]["n"] * 2\nreturn _item',
    items: [{ json: { n: 21 } }],
    item: { json: { n: 21 } },
  })
  assert.deepEqual(result.ok && result.output, { json: { n: 21, double: 42 } })
})

test('print() output is captured as logs', async () => {
  const result = await runPython({ code: 'print("hello", 42)', items: [] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.logs, ['hello 42'])
})

test('state does not bleed between runs', async () => {
  await runPython({ code: 'leaked = "secret"', items: [] })
  const result = await runPython({ code: 'return "leaked" in globals()', items: [] })
  assert.equal(result.ok && result.output, false)
})

test('a Python exception surfaces its message, not a host crash', async () => {
  const result = await runPython({ code: 'raise ValueError("bad input")', items: [] })
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.error : '', /ValueError: bad input/)
})

test('a syntax error is reported', async () => {
  const result = await runPython({ code: 'def broken(:', items: [] })
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.error : '', /SyntaxError/)
})

test('a non-serializable result is rejected with a clear error', async () => {
  const result = await runPython({ code: 'return lambda x: x', items: [] })
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.error : '', /JSON/i)
})

test('code without a return comes back as null output', async () => {
  const result = await runPython({ code: 'x = 1', items: [] })
  assert.deepEqual(result, { ok: true, output: null, logs: [] })
})

test('a runaway sync loop is interrupted by the timeout', async () => {
  // Sync Python blocks the Node event loop, so a Promise.race alone can never
  // fire — this only passes if the interrupt-buffer watchdog actually works.
  const result = await runPython({ code: 'while True:\n    pass', items: [], timeoutMs: 500 })
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.error : '', /timed out/i)
})

test('the interpreter still works after an interrupt', async () => {
  const result = await runPython({ code: 'return "alive"', items: [] })
  assert.equal(result.ok && result.output, 'alive')
})

test('Python log volume is capped with a stated tail', async () => {
  const result = await runPython({ code: 'for i in range(50000):\n    print("spam", i)\nreturn 1', items: [], timeoutMs: 30_000 })
  assert.equal(result.ok, true, !result.ok ? result.error : '')
  const logs = result.ok ? result.logs : []
  assert.ok(logs.length <= CODE_MAX_LOG_LINES + 1, `expected <= ${CODE_MAX_LOG_LINES + 1}, got ${logs.length}`)
  assert.match(logs.at(-1) ?? '', /more line/)
})

test('an oversized Python return is rejected with an actionable error', async () => {
  const result = await runPython({ code: 'return ["xxxxxxxxxx"] * 500000', items: [], timeoutMs: 30_000 })
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.error : '', /too large/i)
})
