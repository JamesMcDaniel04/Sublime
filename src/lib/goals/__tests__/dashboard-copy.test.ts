import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeGoals, activeOrgGoals, firstRunSteps, goalPresets, impactSentence } from '../dashboard-copy'

const goal = (name: string, overrides: Partial<{ personal: boolean; status: 'active' | 'paused' }> = {}) => ({
  name,
  personal: false,
  status: 'active' as const,
  ...overrides,
})

test('activeOrgGoals keeps only non-personal, active goals', () => {
  const mixed = [
    goal('Q3 ARR'),
    goal('My personal quota', { personal: true }),
    goal('Paused org goal', { status: 'paused' }),
    goal('Paused personal goal', { personal: true, status: 'paused' }),
    goal('Launch v2'),
  ]
  assert.deepEqual(activeOrgGoals(mixed).map((g) => g.name), ['Q3 ARR', 'Launch v2'])
  assert.deepEqual(activeOrgGoals([]), [])
  assert.deepEqual(activeOrgGoals([goal('Personal only', { personal: true })]), [])
})

test('activeGoals counts any active goal regardless of personal/org — onboarding must not dead-end on a personal-only goal', () => {
  assert.deepEqual(activeGoals([goal('Personal quota', { personal: true })]).map((g) => g.name), ['Personal quota'])
  assert.deepEqual(activeGoals([goal('Org goal')]).map((g) => g.name), ['Org goal'])
  assert.deepEqual(activeGoals([goal('Paused personal', { personal: true, status: 'paused' })]), [])
  const mixed = [
    goal('Active personal', { personal: true }),
    goal('Active org'),
    goal('Paused org', { status: 'paused' }),
  ]
  assert.deepEqual(activeGoals(mixed).map((g) => g.name), ['Active personal', 'Active org'])
  assert.deepEqual(activeGoals([]), [])
})

test('goalPresets returns null when there are no active org goals', () => {
  assert.equal(goalPresets([]), null)
  assert.equal(goalPresets([goal('Q3 ARR', { personal: true })]), null)
  assert.equal(goalPresets([goal('Q3 ARR', { status: 'paused' })]), null)
})

test('goalPresets anchors prompts to up to two goal names', () => {
  const presets = goalPresets([goal('Q3 ARR'), goal('Launch v2'), goal('Cut churn')])
  assert.ok(presets)
  // Two named "what moved" chips, one generic time-loss chip, one propose chip.
  assert.equal(presets.length, 4)
  assert.equal(presets[0].label, 'What moved on Q3 ARR this week?')
  assert.ok(presets[0].prompt.includes('"Q3 ARR"'))
  assert.equal(presets[0].sendNow, true)
  assert.equal(presets[1].label, 'What moved on Launch v2 this week?')
  assert.equal(presets[2].label, 'Where am I losing time?')
  assert.equal(presets[3].label, 'Propose an agent for Q3 ARR')
  assert.equal(presets[3].sendNow, false)
})

test('goalPresets with a single goal yields three chips', () => {
  const presets = goalPresets([goal('Q3 ARR')])
  assert.ok(presets)
  assert.equal(presets.length, 3)
})

test('goalPresets ignores personal goals even when mixed with org goals — the strip and chips stay org-scoped', () => {
  const presets = goalPresets([
    goal('Personal quota', { personal: true }),
    goal('Q3 ARR'),
    goal('Paused org goal', { status: 'paused' }),
  ])
  assert.ok(presets)
  assert.equal(presets.length, 3)
  assert.equal(presets[0].label, 'What moved on Q3 ARR this week?')
})

test('goalPresets returns null for an org with only personal or only paused goals', () => {
  assert.equal(goalPresets([goal('Personal only', { personal: true })]), null)
  assert.equal(goalPresets([goal('Personal', { personal: true }), goal('Paused org', { status: 'paused' })]), null)
})

test('impactSentence summarizes runs and goals, and hides when empty', () => {
  assert.equal(impactSentence(null), null)
  assert.equal(impactSentence({ measured: { runsCompleted: 0 }, goalsTracked: 2 }), null)
  assert.equal(
    impactSentence({ measured: { runsCompleted: 12 }, goalsTracked: 3 }),
    'Specialized agents have completed 12 runs across 3 tracked goals.',
  )
  assert.equal(
    impactSentence({ measured: { runsCompleted: 1 }, goalsTracked: 1 }),
    'Specialized agents have completed 1 run across 1 tracked goal.',
  )
})

test('firstRunSteps marks progress and hides once everything exists', () => {
  const fresh = firstRunSteps({ connections: 0, goals: 0, agents: 0 })
  assert.equal(fresh.showGuide, true)
  assert.deepEqual(fresh.steps.map((step) => step.done), [false, false, false])
  assert.deepEqual(fresh.steps.map((step) => step.key), ['connect', 'goal', 'deploy'])
  assert.equal(fresh.steps[0].href, '/integrations')
  assert.equal(fresh.steps[1].href, '/goals/new')
  assert.equal(fresh.steps[2].href, '/agents')

  const partial = firstRunSteps({ connections: 3, goals: 0, agents: 1 })
  assert.equal(partial.showGuide, true)
  assert.deepEqual(partial.steps.map((step) => step.done), [true, false, true])
  assert.ok(partial.steps[0].detail.includes('3'))

  const done = firstRunSteps({ connections: 1, goals: 1, agents: 1 })
  assert.equal(done.showGuide, false)
})

test('firstRunSteps "goal" step completes on a count of one — callers pass activeGoals(goals).length, so a personal-only goal counts', () => {
  const personalOnly = activeGoals([goal('My personal quota', { personal: true })]).length
  const result = firstRunSteps({ connections: 0, goals: personalOnly, agents: 0 })
  assert.equal(result.steps[1].done, true)
  assert.ok(result.steps[1].detail.includes('1'))
})

test('firstRunSteps "goal" step stays open when the only goal is paused', () => {
  const pausedOnly = activeGoals([goal('Paused goal', { status: 'paused' })]).length
  const result = firstRunSteps({ connections: 0, goals: pausedOnly, agents: 0 })
  assert.equal(result.steps[1].done, false)
  assert.equal(result.showGuide, true)
})
