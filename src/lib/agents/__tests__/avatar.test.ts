import test from 'node:test'
import assert from 'node:assert/strict'
import { avatarSeedFor, randomAvatarSeed } from '../avatar'

test('an agent with no stored seed falls back to its id', () => {
  // This is why introducing avatars needed no backfill: every pre-existing
  // agent already had a stable seed in the column it was always keyed by.
  assert.equal(avatarSeedFor({ id: 'agt_marcus' }), 'agt_marcus')
  assert.equal(avatarSeedFor({ id: 'agt_marcus', avatarSeed: null }), 'agt_marcus')
  assert.equal(avatarSeedFor({ id: 'agt_marcus', avatarSeed: '   ' }), 'agt_marcus')
})

test('a stored seed wins over the id', () => {
  assert.equal(avatarSeedFor({ id: 'agt_marcus', avatarSeed: 'r7x2' }), 'r7x2')
})

test('re-rolling twice in the same millisecond yields different seeds', () => {
  // Without the counter, two fast clicks could return the same string and the
  // re-roll would silently do nothing.
  const seeds = new Set(Array.from({ length: 50 }, () => randomAvatarSeed()))
  assert.equal(seeds.size, 50)
})
