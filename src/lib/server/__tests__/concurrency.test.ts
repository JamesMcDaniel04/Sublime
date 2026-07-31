import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapWithConcurrency } from '@/lib/server/concurrency'

describe('mapWithConcurrency', () => {
  it('maps every item in order and preserves results', async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10)
    assert.deepEqual(
      results.map((r) => (r.ok ? r.value : null)),
      [10, 20, 30, 40, 50],
    )
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
    })
    assert.ok(peak <= 3, `peak in-flight was ${peak}, expected <= 3`)
    assert.ok(peak > 1, `peak in-flight was ${peak}, expected parallelism > 1`)
  })

  it('contains a rejection to its item and keeps processing the rest', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    assert.equal(results[0].ok, true)
    assert.equal(results[1].ok, false)
    assert.equal(results[2].ok, true)
    assert.equal((results[1] as { ok: false; error: Error }).error.message, 'boom')
  })

  it('handles an empty list and rejects a zero limit', async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), [])
    await assert.rejects(() => mapWithConcurrency([1], 0, async () => 1), /limit must be >= 1/)
  })
})
