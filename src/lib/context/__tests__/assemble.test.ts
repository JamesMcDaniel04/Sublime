import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capByBudget, dedupeAcrossSystems, DEFAULT_CONTEXT_BUDGET_CHARS } from '../assemble'

test('capByBudget keeps highest-scored items that fit the character budget, preserving input order', () => {
  const items = [
    { text: 'a'.repeat(100), score: 0.9 },
    { text: 'b'.repeat(100), score: 0.2 },
    { text: 'c'.repeat(100), score: 0.8 },
  ]
  const kept = capByBudget(items, (item) => item.text, (item) => item.score, 220)
  // 0.9 and 0.8 fit; 0.2 dropped. Original relative order retained (a before c).
  assert.deepEqual(kept.map((item) => item.score), [0.9, 0.8])
})

test('capByBudget without scores keeps leading items up to the budget', () => {
  const items = [{ text: 'x'.repeat(150) }, { text: 'y'.repeat(150) }, { text: 'z'.repeat(150) }]
  const kept = capByBudget(items, (item) => item.text, () => undefined, 320)
  assert.equal(kept.length, 2)
  assert.ok(kept[0].text.startsWith('x'))
})

test('dedupeAcrossSystems drops later near-duplicate texts across systems', () => {
  const first = [{ text: 'Account Acme — Sales AI status: healthy, renewal Oct.' }]
  const second = [
    { text: 'Account Acme — Sales AI status: healthy, renewal Oct.' }, // exact dupe of system 1
    { text: 'Totally different memory about emails.' },
  ]
  const [keptFirst, keptSecond] = dedupeAcrossSystems([first, second], (item) => item.text)
  assert.equal(keptFirst.length, 1)
  assert.deepEqual(keptSecond.map((item) => item.text), ['Totally different memory about emails.'])
})

test('a sane default budget exists', () => {
  assert.ok(DEFAULT_CONTEXT_BUDGET_CHARS >= 8000 && DEFAULT_CONTEXT_BUDGET_CHARS <= 60000)
})

test('createContextAssembler: shared budget + cross-take dedupe, earlier takes win', async () => {
  const { createContextAssembler } = await import('../assemble')
  const assembler = createContextAssembler(250)
  const first = assembler.take(
    [{ text: 'A'.repeat(100), score: 0.9 }, { text: 'B'.repeat(100), score: 0.5 }],
    (item) => item.text,
    (item) => item.score,
  )
  assert.equal(first.length, 2)
  const second = assembler.take(
    [
      { text: 'A'.repeat(100), score: 0.99 }, // dupe of an earlier take → dropped
      { text: 'C'.repeat(100), score: 0.9 }, // over remaining 50-char budget → dropped
      { text: 'D'.repeat(40), score: 0.4 }, // fits
    ],
    (item) => item.text,
    (item) => item.score,
  )
  assert.deepEqual(second.map((item) => item.text[0]), ['D'])
})
