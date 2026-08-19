import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AVATAR_PART_COUNTS, avatarPartsFor, avatarSeedFor } from '../avatar'

test('the same seed always yields the same face — an agent identity must never drift between renders', () => {
  const first = avatarPartsFor('agt_marcus')
  const second = avatarPartsFor('agt_marcus')
  assert.deepEqual(first, second)
})

test('every part index stays inside its palette, for arbitrary seeds including empty and unicode', () => {
  for (const seed of ['', ' ', 'a', '🙂', 'x'.repeat(500), 'cmf0zq1x40001abcd']) {
    const parts = avatarPartsFor(seed)
    for (const [name, count] of Object.entries(AVATAR_PART_COUNTS)) {
      const index = parts[name as keyof typeof parts]
      assert.ok(
        Number.isInteger(index) && index >= 0 && index < count,
        `${name} index ${index} out of range 0..${count - 1} for seed "${seed}"`,
      )
    }
  }
})

// cuid()-generated ids share a long prefix (leading 'c' plus a base36 timestamp),
// so agents created in the same session differ only in their trailing characters.
// A hash that samples early characters would give a whole workspace one face.
test('cuid-style ids sharing a long prefix still get visibly distinct faces', () => {
  const ids = Array.from({ length: 50 }, (_, index) => `cmf0zq1x4000${index.toString().padStart(4, '0')}sublime`)
  const faces = new Set(ids.map((id) => JSON.stringify(avatarPartsFor(id))))
  assert.ok(faces.size >= 45, `expected near-unique faces across sibling cuids, got ${faces.size}/50`)
})

test('faces spread across each palette instead of clustering on one value', () => {
  const seeds = Array.from({ length: 200 }, (_, index) => `agent-${index}`)
  const parts = seeds.map((seed) => avatarPartsFor(seed))
  for (const [name, count] of Object.entries(AVATAR_PART_COUNTS)) {
    const used = new Set(parts.map((part) => part[name as keyof typeof part]))
    assert.ok(used.size >= Math.min(count, 3), `${name} only used ${used.size} of ${count} options across 200 seeds`)
  }
})

test('an explicit stored seed wins over the agent id, so a re-rolled face sticks', () => {
  const rerolled = avatarSeedFor({ id: 'agt_1', avatarSeed: 'reroll-7' })
  assert.equal(rerolled, 'reroll-7')
  assert.notDeepEqual(avatarPartsFor(rerolled), avatarPartsFor('agt_1'))
})

test('a missing seed falls back to the agent id, so existing agents need no backfill', () => {
  assert.equal(avatarSeedFor({ id: 'agt_1' }), 'agt_1')
  assert.equal(avatarSeedFor({ id: 'agt_1', avatarSeed: null }), 'agt_1')
  assert.equal(avatarSeedFor({ id: 'agt_1', avatarSeed: '   ' }), 'agt_1')
})
