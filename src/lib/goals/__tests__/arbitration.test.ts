import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankGoals, arbitrationSection, type ArbitrationGoal } from '../arbitration'

const goal = (over: Partial<ArbitrationGoal>): ArbitrationGoal => ({
  id: 'g1',
  name: 'Goal',
  riskLevel: 'on_track',
  targetDate: new Date('2026-12-31'),
  priority: null,
  ...over,
})

test('rankGoals orders by risk severity when no priorities are set', () => {
  const ranked = rankGoals([
    goal({ id: 'a', riskLevel: 'on_track' }),
    goal({ id: 'b', riskLevel: 'off_track' }),
    goal({ id: 'c', riskLevel: 'at_risk' }),
    goal({ id: 'd', riskLevel: 'no_data' }),
  ])
  assert.deepEqual(ranked.map((g) => g.id), ['b', 'c', 'a', 'd'])
})

test('rankGoals: any user-set priority outranks every unset one, lower number first', () => {
  const ranked = rankGoals([
    goal({ id: 'a', riskLevel: 'off_track', priority: null }),
    goal({ id: 'b', riskLevel: 'on_track', priority: 2 }),
    goal({ id: 'c', riskLevel: 'no_data', priority: 1 }),
  ])
  assert.deepEqual(ranked.map((g) => g.id), ['c', 'b', 'a'])
})

test('rankGoals: equal priority falls back to risk, then nearest deadline, then id', () => {
  const ranked = rankGoals([
    goal({ id: 'late', priority: 1, targetDate: new Date('2027-06-30') }),
    goal({ id: 'soon', priority: 1, targetDate: new Date('2026-09-30') }),
    goal({ id: 'risky', priority: 1, riskLevel: 'at_risk', targetDate: new Date('2027-06-30') }),
  ])
  assert.deepEqual(ranked.map((g) => g.id), ['risky', 'soon', 'late'])

  const tie = rankGoals([goal({ id: 'zz', priority: 1 }), goal({ id: 'aa', priority: 1 })])
  assert.deepEqual(tie.map((g) => g.id), ['aa', 'zz'])
})

test('rankGoals does not mutate its input', () => {
  const input = [goal({ id: 'a', riskLevel: 'no_data' }), goal({ id: 'b', riskLevel: 'off_track' })]
  rankGoals(input)
  assert.deepEqual(input.map((g) => g.id), ['a', 'b'])
})

test('arbitrationSection is empty below two goals', () => {
  assert.equal(arbitrationSection([]), '')
  assert.equal(arbitrationSection([goal({ id: 'a' })]), '')
})

test('arbitrationSection renders the ranking with risk levels and the trade-off rule', () => {
  const section = arbitrationSection(
    rankGoals([
      goal({ id: 'a', name: 'Grow ARR', riskLevel: 'off_track', priority: null }),
      goal({ id: 'b', name: 'Cut churn', riskLevel: 'on_track', priority: null }),
    ]),
  )
  assert.match(section, /^## Goal priorities\n/)
  const arrIndex = section.indexOf('Grow ARR')
  const churnIndex = section.indexOf('Cut churn')
  assert.ok(arrIndex !== -1 && churnIndex !== -1 && arrIndex < churnIndex)
  assert.match(section, /off_track/)
  assert.match(section, /higher-ranked/)
})
