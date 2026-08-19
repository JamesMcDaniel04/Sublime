import { test } from 'node:test'
import assert from 'node:assert/strict'
import { meterTokens } from '../meter'

function harness(record: (org: string, tokens: number) => Promise<number | null>) {
  const logged: Array<{ message: string; meta?: unknown }> = []
  return {
    logged,
    deps: { record, logger: { error: (message: string, meta?: unknown) => { logged.push({ message, meta }) } } },
  }
}

test('spend is recorded against the workspace', async () => {
  const calls: Array<[string, number]> = []
  const h = harness(async (org, tokens) => { calls.push([org, tokens]); return tokens })
  await meterTokens({ organizationId: 'org_1', tokens: 1200, path: '/api/agents/draft' }, h.deps)
  assert.deepEqual(calls, [['org_1', 1200]])
  assert.deepEqual(h.logged, [], 'a successful meter is silent')
})

// The defect this replaces: every call site was `void record(...).catch(() => undefined)`,
// so a dropped write under-billed the workspace and nothing counted the misses.
test('a meter backend that is down is logged, never swallowed', async () => {
  const h = harness(async () => null)
  await meterTokens({ organizationId: 'org_1', tokens: 900, path: '/api/assistant/chat' }, h.deps)
  assert.equal(h.logged.length, 1)
  assert.match(h.logged[0].message, /not counted|unrecorded|failed/i)
  assert.deepEqual(h.logged[0].meta, { organizationId: 'org_1', tokens: 900, path: '/api/assistant/chat', estimated: false })
})

test('a throwing meter is logged and never breaks the request it is measuring', async () => {
  const h = harness(async () => { throw new Error('redis unreachable') })
  await assert.doesNotReject(() => meterTokens({ organizationId: 'org_1', tokens: 50, path: '/x' }, h.deps))
  assert.equal(h.logged.length, 1)
  assert.match(String((h.logged[0].meta as { error?: string })?.error ?? ''), /redis unreachable/)
})

// Estimated spend is real money billed on a guess; it has to be auditable.
test('estimated spend is marked so it can be told apart from measured spend', async () => {
  const h = harness(async () => null)
  await meterTokens({ organizationId: 'org_1', tokens: 400, path: '/api/agents/draft', estimated: true }, h.deps)
  assert.equal((h.logged[0].meta as { estimated?: boolean }).estimated, true)
})

test('nothing is recorded for a non-positive or unusable token count', async () => {
  const calls: number[] = []
  const h = harness(async (_org, tokens) => { calls.push(tokens); return tokens })
  for (const tokens of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await meterTokens({ organizationId: 'org_1', tokens, path: '/x' }, h.deps)
  }
  assert.deepEqual(calls, [], 'no backend call for spend that did not happen')
  assert.deepEqual(h.logged, [], 'and nothing to alarm about either')
})
