import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEW_AGENT, initialAgentSelection, syncAgentSelection } from '../agent-selection'

const known = ['agt_1', 'agt_2'] as const

// The flash: selection used to start as null and get reconciled in an effect,
// which runs after the first paint — so opening ?agent=X painted the roster for
// a frame before swapping to the workspace.
test('the first render already knows which agent the URL names', () => {
  assert.equal(initialAgentSelection('agt_1'), 'agt_1')
  assert.equal(initialAgentSelection(NEW_AGENT), NEW_AGENT)
  assert.equal(initialAgentSelection(null), null)
})

// The bounce: on a cold load the roster has no agents yet, so the param cannot
// be validated. Stripping it there threw the user out of the agent they asked
// for, permanently.
test('a URL agent is left alone while the roster is still loading', () => {
  const result = syncAgentSelection({ param: 'agt_1', selected: null, knownAgentIds: [], rosterReady: false, paramChanged: true })
  assert.deepEqual(result, {}, 'no selection change and no URL rewrite until we can judge the param')
})

test('once the roster is ready a known URL agent is adopted', () => {
  const result = syncAgentSelection({ param: 'agt_1', selected: null, knownAgentIds: known, rosterReady: true, paramChanged: true })
  assert.deepEqual(result, { select: 'agt_1' })
})

test('setup mode is adopted from the URL without needing the roster', () => {
  const result = syncAgentSelection({ param: NEW_AGENT, selected: null, knownAgentIds: [], rosterReady: false, paramChanged: true })
  assert.deepEqual(result, { select: NEW_AGENT })
})

// Entering from the roster is the one transition Back should undo.
test('entering an agent from the roster pushes a history entry', () => {
  const result = syncAgentSelection({ param: null, selected: 'agt_1', knownAgentIds: known, rosterReady: true, paramChanged: false })
  assert.deepEqual(result, { url: { mode: 'push', agentId: 'agt_1' } })
})

test('switching between agents replaces rather than stacking history', () => {
  const result = syncAgentSelection({ param: 'agt_1', selected: 'agt_2', knownAgentIds: known, rosterReady: true, paramChanged: false })
  assert.deepEqual(result, { url: { mode: 'replace', agentId: 'agt_2' } })
})

// Deleting leaves no history entry pointing at something that no longer exists.
test('leaving an agent replaces the URL back to the roster', () => {
  const result = syncAgentSelection({ param: 'agt_1', selected: null, knownAgentIds: known, rosterReady: true, paramChanged: false })
  assert.deepEqual(result, { url: { mode: 'replace', agentId: null } })
})

// The same inputs mean opposite things depending on which side moved, which is
// precisely what the two duelling effects could not express: a link arriving
// should be ADOPTED, while a selection cleared by the user should be MIRRORED.
test('identical state is read by which side moved, not by the values alone', () => {
  const shared = { param: 'agt_1', selected: null, knownAgentIds: known, rosterReady: true }
  assert.deepEqual(
    syncAgentSelection({ ...shared, paramChanged: true }),
    { select: 'agt_1' },
    'a link arrived — adopt it',
  )
  assert.deepEqual(
    syncAgentSelection({ ...shared, paramChanged: false }),
    { url: { mode: 'replace', agentId: null } },
    'the user left the agent — clear the URL',
  )
})

test('a URL naming an agent that does not exist falls back to the roster', () => {
  const result = syncAgentSelection({ param: 'agt_gone', selected: null, knownAgentIds: known, rosterReady: true, paramChanged: true })
  assert.deepEqual(result, { url: { mode: 'replace', agentId: null } })
})

// An agent deleted in another tab must not strand this one in an empty workspace.
test('a selected agent that disappears from the roster clears the selection', () => {
  const result = syncAgentSelection({ param: 'agt_gone', selected: 'agt_gone', knownAgentIds: known, rosterReady: true, paramChanged: false })
  assert.deepEqual(result, { select: null })
})

test('a settled selection asks for no change at all', () => {
  assert.deepEqual(
    syncAgentSelection({ param: 'agt_1', selected: 'agt_1', knownAgentIds: known, rosterReady: true, paramChanged: false }),
    {},
    'the steady state must be inert, or the effect loops',
  )
  assert.deepEqual(
    syncAgentSelection({ param: null, selected: null, knownAgentIds: known, rosterReady: true, paramChanged: false }),
    {},
  )
  assert.deepEqual(
    syncAgentSelection({ param: NEW_AGENT, selected: NEW_AGENT, knownAgentIds: [], rosterReady: true, paramChanged: false }),
    {},
    'setup mode is never checked against the roster',
  )
})

test('browser Back out of an agent returns to the roster', () => {
  const result = syncAgentSelection({
    param: null, selected: 'agt_1', knownAgentIds: known, rosterReady: true, paramChanged: true,
  })
  assert.deepEqual(result, { select: null }, 'the URL lost its agent, so the surface follows it')
})
