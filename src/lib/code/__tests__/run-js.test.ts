/**
 * The Code node's JavaScript runner (node:vm).
 *
 * The invariants worth protecting: user code sees ONLY its declared surface
 * (`items` / `item` / `$input` / console), never the host process; a runaway
 * loop cannot hang the worker; and everything the code produces — return
 * value, logs, thrown error — comes back in a structured result rather than
 * leaking through the host's stdout.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runJavaScript, CODE_MAX_LOG_LINES } from '../run-js'

test('returns the return value of the code', async () => {
  const result = await runJavaScript({ code: 'return 1 + 1', items: [] })
  assert.deepEqual(result, { ok: true, output: 2, logs: [] })
})

test('exposes items and the n8n-style $input helpers', async () => {
  const items = [{ id: 1 }, { id: 2 }]
  const viaItems = await runJavaScript({ code: 'return items.map((i) => i.id)', items })
  assert.deepEqual(viaItems.ok && viaItems.output, [1, 2])
  const viaInput = await runJavaScript({ code: 'return $input.all().length + $input.first().id', items })
  assert.equal(viaInput.ok && viaInput.output, 3)
})

test('exposes the current item in eachItem mode', async () => {
  const result = await runJavaScript({ code: 'return item.id * 10', items: [{ id: 4 }], item: { id: 4 } })
  assert.equal(result.ok && result.output, 40)
  const viaInput = await runJavaScript({ code: 'return $input.item.id', items: [{ id: 4 }], item: { id: 4 } })
  assert.equal(viaInput.ok && viaInput.output, 4)
})

test('supports await', async () => {
  const result = await runJavaScript({ code: 'const x = await Promise.resolve(7); return x', items: [] })
  assert.equal(result.ok && result.output, 7)
})

test('captures console.log output as strings', async () => {
  const result = await runJavaScript({ code: 'console.log("a", 1, {b: 2}); return null', items: [] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.logs, ['a 1 {"b":2}'])
})

test('a thrown error comes back structured, with its message', async () => {
  const result = await runJavaScript({ code: 'throw new Error("boom")', items: [] })
  assert.deepEqual(result, { ok: false, error: 'boom', logs: [] })
})

test('a syntax error is reported, not thrown at the host', async () => {
  const result = await runJavaScript({ code: 'return ((', items: [] })
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.error : '', /Unexpected/i)
})

test('an infinite loop is stopped by the timeout', async () => {
  const result = await runJavaScript({ code: 'while (true) {}', items: [], timeoutMs: 200 })
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.error : '', /timed out/i)
})

test('a never-resolving await is stopped by the timeout', async () => {
  const result = await runJavaScript({ code: 'await new Promise(() => {}); return 1', items: [], timeoutMs: 200 })
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.error : '', /timed out/i)
})

test('host process internals are not reachable', async () => {
  for (const probe of ['typeof process', 'typeof require', 'typeof globalThis.process']) {
    const result = await runJavaScript({ code: `return ${probe}`, items: [] })
    assert.equal(result.ok && result.output, 'undefined', `${probe} must be undefined`)
  }
})

test('host functions cannot be used as a constructor escape into Node', async () => {
  const probes = [
    "setTimeout.constructor('return typeof process')()",
    "console.log.constructor('return typeof process')()",
    "Object.getPrototypeOf(setTimeout).constructor('return typeof require')()",
  ]
  for (const probe of probes) {
    const result = await runJavaScript({ code: `return ${probe}`, items: [] })
    assert.equal(result.ok && result.output, 'undefined', `${probe} must stay inside QuickJS`)
  }
})

test('mutating items inside the sandbox cannot corrupt the host copy', async () => {
  const items = [{ id: 1 }]
  await runJavaScript({ code: 'items[0].id = 999; return items', items })
  assert.equal(items[0].id, 1)
})

test('a non-JSON-serializable return is rejected with a clear error', async () => {
  const result = await runJavaScript({ code: 'return () => 1', items: [] })
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.error : '', /JSON/i)
})

test('setTimeout inside the sandbox works for small delays', async () => {
  // n8n's Code node allows awaiting timers; a sandbox with no timers rejects
  // real-world snippets (backoff sleeps).
  const result = await runJavaScript({
    code: 'await new Promise((resolve) => setTimeout(resolve, 10)); return "slept"',
    items: [],
  })
  assert.equal(result.ok && result.output, 'slept')
})

// ── Resource bounds ─────────────────────────────────────────────────────────
// A step's output and logs are persisted to a run row and held in memory, so
// neither may be unbounded — the HTTP node has capped its response since day
// one and code needs the same discipline.

test('log volume is capped, and the truncation is stated rather than silent', async () => {
  const result = await runJavaScript({ code: 'for (let i = 0; i < 50000; i++) console.log("spam", i); return 1', items: [], timeoutMs: 20_000 })
  assert.equal(result.ok, true)
  const logs = result.ok ? result.logs : []
  assert.ok(logs.length <= CODE_MAX_LOG_LINES + 1, `expected <= ${CODE_MAX_LOG_LINES + 1} lines, got ${logs.length}`)
  assert.match(logs.at(-1) ?? '', /more line/, 'the last line says what was dropped')
})

test('an oversized return value is rejected with an actionable error', async () => {
  const result = await runJavaScript({ code: 'return new Array(500000).fill("xxxxxxxxxx")', items: [], timeoutMs: 20_000 })
  assert.equal(result.ok, false)
  assert.match(!result.ok ? result.error : '', /too large/i)
})

test('an output just under the cap still succeeds', async () => {
  const result = await runJavaScript({ code: 'return "x".repeat(1000)', items: [] })
  assert.equal(result.ok, true)
  assert.equal(result.ok && (result.output as string).length, 1000)
})
