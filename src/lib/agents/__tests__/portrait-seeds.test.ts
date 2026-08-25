/**
 * The seeds a portrait picker offers.
 *
 * A seed maps to a portrait through a hash that only runs forwards, so the
 * picker cannot ask for portrait N directly. These pin the properties that
 * make searching for them acceptable: every face is offered, none twice, and
 * the answer never changes between renders — a picker that reshuffled would
 * move the face someone was about to click.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { portraitSeeds, portraitFor, PORTRAIT_COUNT } from '../avatar-portraits'

test('every portrait is offered', () => {
  assert.equal(portraitSeeds().length, PORTRAIT_COUNT)
})

test('no portrait is offered twice', () => {
  const portraits = portraitSeeds().map((seed) => portraitFor(seed))
  assert.equal(new Set(portraits).size, PORTRAIT_COUNT, 'two seeds resolved to the same face')
})

test('the offered seeds do not change between calls', () => {
  assert.deepEqual(portraitSeeds(), portraitSeeds())
})

test('a chosen seed keeps resolving to the face that was clicked', () => {
  for (const seed of portraitSeeds()) {
    assert.equal(portraitFor(seed), portraitFor(seed))
  }
})
