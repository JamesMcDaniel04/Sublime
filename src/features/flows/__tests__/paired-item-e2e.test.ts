/**
 * Paired-item lineage through a real loop.
 *
 * The resolver tests prove the pairing rule; this proves the rule is reachable
 * from a flow — that a loop body can line up an earlier step's array with the
 * item it is currently processing, which is the whole point.
 *
 * Uses the real interpreter so the loop context (`loop.index`/`count`) comes
 * from execution rather than from a fixture I wrote to match my expectations.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow } from '../interpret'

const graph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    // Runs once, before the loop, producing an array parallel to the items.
    { id: 'lookup', type: 'code', data: { label: 'Lookup', code: 'return [{ email: "a@x.com" }, { email: "b@x.com" }]' } },
    { id: 'each', type: 'loop', data: { label: 'Each', over: '{{step.lookup.output}}', concurrency: 1, body: ['send'] } },
    // Reads BOTH the current item and the paired item from the earlier step.
    { id: 'send', type: 'agent', data: { label: 'Send', agentId: 'send', input: 'to={{Lookup.item.email}} idx={{loop.index}}' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'lookup' },
    { id: 'e1', source: 'lookup', target: 'each' },
  ],
}

test('a loop body reads the paired item from an earlier step', async () => {
  const seen: { to: unknown; idx: unknown }[] = []

  const result = await interpretFlow(graph as never, {}, {
    runCode: async () => ({ ok: true, output: [{ email: 'a@x.com' }, { email: 'b@x.com' }], logs: [] }),
    // The body's input has already had its tokens rendered, so what arrives
    // here IS the resolved pairing.
    runAgent: async ({ input }: { input: unknown }) => {
      const to = /to=(\S*)/.exec(String(input))?.[1]
      const idx = /idx=(\S*)/.exec(String(input))?.[1]
      seen.push({ to, idx })
      return { output: to }
    },
  } as never)

  assert.equal(result.status, 'succeeded', `the run failed: ${result.error}`)
  assert.equal(seen.length, 2, `the loop body ran ${seen.length} times`)

  // The load-bearing assertion: iteration 0 got a@, iteration 1 got b@.
  assert.deepEqual(
    seen.map((entry) => entry.to),
    ['a@x.com', 'b@x.com'],
    'the paired item did not line up with the iteration',
  )
})
