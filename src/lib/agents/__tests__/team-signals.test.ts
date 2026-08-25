/**
 * What the roster should be telling you before you read the tiles.
 *
 * A team page that only lists members answers "who is here". It does not
 * answer the two questions someone actually opens it with: is anything wrong,
 * and should I be hiring. Both signals already exist in the data — an agent
 * blocked on a human, an agent that has never run, a library of templates
 * nobody has looked at — and were visible only by reading every card.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamIssues, ISSUE_RANK } from '../team-signals'

const kpis = (over: Partial<{ runs: number; failed: number; recorded: number; waiting: number; running: number }> = {}) => ({
  runs: 0, failed: 0, recorded: 0, waiting: 0, running: 0,
  successRate: null, minutesSavedPerRun: null, hoursSaved: null,
  ...over,
})

const member = (id: string, name: string, over = {}) => ({ id, name, kpis: kpis(over) })

// ── which agents are flagged ────────────────────────────────────────────────

test('an agent blocked on a person is an issue', () => {
  const issues = teamIssues([member('a', 'Auditor', { waiting: 2, recorded: 5 })])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'waiting')
  assert.equal(issues[0].agentId, 'a')
})

test('an agent with failures is an issue', () => {
  const issues = teamIssues([member('a', 'Auditor', { failed: 3, recorded: 10 })])
  assert.equal(issues[0].kind, 'failing')
})

// A hire that never ran is the quiet failure: it looks fine on the roster and
// has delivered nothing since the day it was created.
test('an agent that has never run is an issue', () => {
  const issues = teamIssues([member('a', 'Auditor')])
  assert.equal(issues[0].kind, 'never_run')
})

test('a healthy agent is not an issue', () => {
  const issues = teamIssues([member('a', 'Auditor', { runs: 10, recorded: 10 })])
  assert.deepEqual(issues, [])
})

// Currently running is not a problem — flagging it would make the bar cry
// wolf every time anything worked.
test('an agent mid-run is not an issue', () => {
  assert.deepEqual(teamIssues([member('a', 'Auditor', { running: 1, recorded: 3, runs: 3 })]), [])
})

// ── ranking ─────────────────────────────────────────────────────────────────

// An agent waiting on a person is actionable RIGHT NOW; a never-run agent has
// been fine for weeks. Ordering by severity is what makes a truncated bar
// still show the thing worth doing.
test('the most actionable issue comes first', () => {
  const issues = teamIssues([
    member('c', 'Never', {}),
    member('b', 'Failing', { failed: 2, recorded: 4 }),
    member('a', 'Waiting', { waiting: 1, recorded: 4 }),
  ])
  assert.deepEqual(issues.map((issue) => issue.kind), ['waiting', 'failing', 'never_run'])
})

test('the ranking is explicit rather than incidental', () => {
  assert.ok(ISSUE_RANK.waiting < ISSUE_RANK.failing)
  assert.ok(ISSUE_RANK.failing < ISSUE_RANK.never_run)
})

// One agent can be both blocked and failing. Reporting it twice would make
// three problems look like six.
test('an agent is reported once, under its most severe issue', () => {
  const issues = teamIssues([member('a', 'Both', { waiting: 1, failed: 2, recorded: 4 })])
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'waiting')
})

test('every issue carries the agent name so the bar needs no second lookup', () => {
  assert.equal(teamIssues([member('a', 'Pipeline Hygiene Auditor', { waiting: 1 })])[0].name, 'Pipeline Hygiene Auditor')
})

// ── edges ───────────────────────────────────────────────────────────────────

test('an empty team has no issues', () => {
  assert.deepEqual(teamIssues([]), [])
})

test('ordering is stable for agents with the same issue', () => {
  const team = [member('b', 'Bee', { waiting: 1 }), member('a', 'Ay', { waiting: 1 })]
  assert.deepEqual(teamIssues(team).map((issue) => issue.agentId), ['b', 'a'])
})
