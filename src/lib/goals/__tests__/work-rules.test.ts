import test from 'node:test'
import assert from 'node:assert/strict'
import { rulesToRetire, rulesToPromote, UNPROBED_TTL_DAYS } from '../work-rules'

const NOW = new Date('2026-07-28T00:00:00Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

const rule = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  signal: 'daysCold',
  statement: 'Do not work subjects whose daysCold is under 14.',
  finding: 'daysCold under 14' as string | null,
  goalId: 'goal-1' as string | null,
  seedKey: null as string | null,
  agentSeedKey: 'sales-sequence-personalizer' as string | null,
  learnedAt: daysAgo(10),
  ...overrides,
})

test('probes that come back used retire the rule', () => {
  const decisions = rulesToRetire([rule()], [{ ruleId: 'r1', probes: 4, used: 3 }], NOW)
  assert.deepEqual(decisions, [{ ruleId: 'r1', reason: 'probes_contradicted' }])
})

test('one used probe is not enough to retire', () => {
  // A single item landing is a fluke, not evidence.
  assert.deepEqual(rulesToRetire([rule()], [{ ruleId: 'r1', probes: 4, used: 1 }], NOW), [])
})

test('probes that confirm the rule leave it standing', () => {
  assert.deepEqual(rulesToRetire([rule()], [{ ruleId: 'r1', probes: 5, used: 0 }], NOW), [])
})

test('a rule nobody probed retires once the TTL passes', () => {
  // The agent ignoring the probe instruction reintroduces the exact
  // calcification the explore allowance exists to prevent.
  const stale = rule({ learnedAt: daysAgo(UNPROBED_TTL_DAYS + 1) })
  assert.deepEqual(rulesToRetire([stale], [], NOW), [{ ruleId: 'r1', reason: 'unprobed' }])
})

test('an unprobed rule inside the TTL is left alone', () => {
  const fresh = rule({ learnedAt: daysAgo(UNPROBED_TTL_DAYS - 1) })
  assert.deepEqual(rulesToRetire([fresh], [], NOW), [])
})

test('an old rule WITH probes is judged on the probes, not the clock', () => {
  const old = rule({ learnedAt: daysAgo(UNPROBED_TTL_DAYS + 30) })
  assert.deepEqual(rulesToRetire([old], [{ ruleId: 'r1', probes: 6, used: 0 }], NOW), [])
})

test('the same lesson on two goals promotes to the seed', () => {
  const decisions = rulesToPromote([
    rule({ id: 'r1', goalId: 'goal-1' }),
    rule({ id: 'r2', goalId: 'goal-2' }),
  ])
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].seedKey, 'sales-sequence-personalizer')
  assert.equal(decisions[0].signal, 'daysCold')
  assert.deepEqual(decisions[0].fromGoalIds.sort(), ['goal-1', 'goal-2'])
})

test('one goal is a quirk, not an org lesson', () => {
  assert.deepEqual(rulesToPromote([rule({ id: 'r1', goalId: 'goal-1' })]), [])
})

test('two rules on the SAME goal do not promote', () => {
  // Distinct goals is the bar; the same goal twice is one observation.
  assert.deepEqual(
    rulesToPromote([rule({ id: 'r1', goalId: 'goal-1' }), rule({ id: 'r2', goalId: 'goal-1' })]),
    [],
  )
})

test('rules from agents without a seed never promote', () => {
  // Nothing to attach an org-wide lesson to.
  assert.deepEqual(
    rulesToPromote([
      rule({ id: 'r1', goalId: 'goal-1', agentSeedKey: null }),
      rule({ id: 'r2', goalId: 'goal-2', agentSeedKey: null }),
    ]),
    [],
  )
})

test('already-promoted seed rules are not re-promoted', () => {
  // A level-2 rule has no goalId and must be excluded from the tally.
  assert.deepEqual(
    rulesToPromote([
      rule({ id: 'r0', goalId: null, seedKey: 'sales-sequence-personalizer' }),
      rule({ id: 'r1', goalId: 'goal-1' }),
      rule({ id: 'r2', goalId: 'goal-2' }),
    ]),
    [],
  )
})

test('different signals on the same seed promote independently', () => {
  const decisions = rulesToPromote([
    rule({ id: 'r1', goalId: 'goal-1', signal: 'daysCold' }),
    rule({ id: 'r2', goalId: 'goal-2', signal: 'daysCold' }),
    rule({ id: 'r3', goalId: 'goal-1', signal: 'contacts' }),
  ])
  assert.deepEqual(
    decisions.map((decision) => decision.signal),
    ['daysCold'],
    'only the signal seen on two goals promotes',
  )
})
