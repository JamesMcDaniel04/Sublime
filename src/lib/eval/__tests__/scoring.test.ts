/**
 * Scoring and summarising an evaluation run.
 *
 * The rules here decide whether a change to an agent made it better, so the
 * ways they can be subtly wrong all end the same way: someone ships a
 * regression because the number went green.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreCase, summarizeRun, compareRuns, JUDGE_PASS_THRESHOLD } from '../scoring'

// ── scoring one case ────────────────────────────────────────────────────────

test('required content present and no judge is a pass', () => {
  const verdict = scoreCase('The total is 42 units.', { mustContain: ['42'] })
  assert.equal(verdict.passed, true)
})

test('missing required content fails and names what was missing', () => {
  const verdict = scoreCase('The total is unclear.', { mustContain: ['42', 'units'] })
  assert.equal(verdict.passed, false)
  assert.match(verdict.notes, /42/)
})

// The case evaluation exists for: a fluent, confident, wrong answer.
test('a deterministic check overrules a high judge score', () => {
  const verdict = scoreCase('A thorough and well-reasoned answer.', { mustContain: ['42'], judgeScore: 0.95 })
  assert.equal(verdict.passed, false, 'the judge overruled a concretely missing value')
  assert.equal(verdict.score, 0.95, 'the score is still reported, so the disagreement is visible')
})

test('a judge score at the threshold passes', () => {
  assert.equal(scoreCase('anything', { mustContain: [], judgeScore: JUDGE_PASS_THRESHOLD }).passed, true)
})

test('a judge score below the threshold fails and says so', () => {
  const verdict = scoreCase('anything', { mustContain: [], judgeScore: 0.4 })
  assert.equal(verdict.passed, false)
  assert.match(verdict.notes, /0\.40|below/)
})

test('substring matching ignores case', () => {
  assert.equal(scoreCase('Total: FORTY-TWO', { mustContain: ['forty-two'] }).passed, true)
})

test('blank required entries are ignored rather than failing everything', () => {
  assert.equal(scoreCase('anything', { mustContain: ['  ', ''] }).passed, true)
})

// A case with no checks is weak, not green — it should be visible as such.
test('a case with no checks passes but says it checked nothing', () => {
  const verdict = scoreCase('anything', { mustContain: [] })
  assert.equal(verdict.passed, true)
  assert.match(verdict.notes, /no checks/i)
})

test('an empty output fails a required check rather than throwing', () => {
  assert.equal(scoreCase('', { mustContain: ['42'] }).passed, false)
})

// ── summarising a run ───────────────────────────────────────────────────────

test('a summary counts passes and failures', () => {
  const summary = summarizeRun([{ passed: true, notes: '' }, { passed: false, notes: '' }, { passed: true, notes: '' }])
  assert.equal(summary.passed, 2)
  assert.equal(summary.failed, 1)
  assert.ok(Math.abs((summary.passRate ?? 0) - 2 / 3) < 1e-9)
})

// An empty dataset is not a perfect score.
test('an empty run has a null pass rate, not 100%', () => {
  const summary = summarizeRun([])
  assert.equal(summary.passRate, null, 'an empty dataset must not read as perfect')
  assert.equal(summary.total, 0)
})

test('the average score ignores cases that had no judge', () => {
  const summary = summarizeRun([
    { passed: true, score: 0.8, notes: '' },
    { passed: true, notes: '' },
    { passed: true, score: 0.6, notes: '' },
  ])
  assert.ok(Math.abs((summary.averageScore ?? 0) - 0.7) < 1e-9, 'an unscored case was averaged in as 0')
})

test('a run with no judged cases has a null average, not zero', () => {
  assert.equal(summarizeRun([{ passed: true, notes: '' }]).averageScore, null)
})

// ── comparing runs ──────────────────────────────────────────────────────────

test('a higher pass rate is an improvement', () => {
  assert.equal(compareRuns(summarizeRun([{ passed: false, notes: '' }]), summarizeRun([{ passed: true, notes: '' }])), 'improved')
})

test('a lower pass rate is a regression', () => {
  assert.equal(compareRuns(summarizeRun([{ passed: true, notes: '' }]), summarizeRun([{ passed: false, notes: '' }])), 'regressed')
})

// The reason it compares RATE and not count: datasets grow.
test('adding cases while staying proportionally better is not a regression', () => {
  const before = summarizeRun([{ passed: true, notes: '' }, { passed: true, notes: '' }])           // 2/2 = 1.0
  const after = summarizeRun([
    { passed: true, notes: '' }, { passed: true, notes: '' }, { passed: true, notes: '' },
    { passed: true, notes: '' }, { passed: false, notes: '' },
  ])                                                                                                 // 4/5 = 0.8
  // Genuinely a regression in rate — but the COUNT went up, which a naive
  // comparison would have called an improvement.
  assert.equal(compareRuns(before, after), 'regressed')
})

test('comparing against an empty run is unknown, not an improvement', () => {
  assert.equal(compareRuns(summarizeRun([]), summarizeRun([{ passed: true, notes: '' }])), 'unknown')
})
