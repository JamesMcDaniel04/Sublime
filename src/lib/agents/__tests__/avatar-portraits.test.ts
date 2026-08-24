import test from 'node:test'
import assert from 'node:assert/strict'
import { PORTRAITS, PORTRAIT_COUNT, portraitFor } from '../avatar-portraits'

test('a seed always resolves to the same portrait', () => {
  // The whole point of deriving rather than storing: an agent's face must not
  // change between devices or deploys.
  assert.deepEqual(portraitFor('agt_marcus'), portraitFor('agt_marcus'))
})

test('every portrait resolves to a real entry', () => {
  for (let i = 0; i < 500; i += 1) {
    const portrait = portraitFor(`agt_${i}`)
    assert.ok(PORTRAITS.includes(portrait), 'portrait comes from the manifest')
  }
})

test('cuid-shaped ids sharing a long prefix still spread across the set', () => {
  // Agent ids are cuids minted in the same session, so they share ~10 leading
  // characters. A hash that samples the front would give a whole workspace one
  // face — this is the regression that motivated hashing the WHOLE string.
  const ids = Array.from({ length: 120 }, (_, i) => `cmd8x2k${String(i).padStart(6, '0')}`)
  const distinct = new Set(ids.map((id) => portraitFor(id).src))
  assert.ok(distinct.size > PORTRAIT_COUNT / 2, `expected wide spread, got ${distinct.size}`)
})

test('the manifest has no duplicate images', () => {
  assert.equal(new Set(PORTRAITS.map((p) => p.src)).size, PORTRAIT_COUNT)
})

test('every portrait declares both light and dark tints', () => {
  // A tint defined for one theme only renders a light tile under a dark
  // surface — the classic theme bug this manifest exists to prevent.
  for (const portrait of PORTRAITS) {
    assert.match(portrait.tint, /^#[0-9A-Fa-f]{6}$/)
    assert.match(portrait.tintDark, /^#[0-9A-Fa-f]{6}$/)
  }
})

test('every image path points into the public avatars directory', () => {
  for (const portrait of PORTRAITS) {
    assert.match(portrait.src, /^\/avatars\/[\w.-]+\.webp$/)
  }
})
