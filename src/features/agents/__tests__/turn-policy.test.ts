import { test } from 'node:test'
import assert from 'node:assert/strict'
import { turnStopOutcome, turnEffortFor } from '../turn-policy'

test('a refusal is not a clean turn — capped with an explicit reason and message', () => {
  const outcome = turnStopOutcome({ stopReason: 'refusal', text: '' })
  assert.equal(outcome.capped, 'model_refusal')
  assert.match((outcome as { finalText: string }).finalText, /declined/i)
})

test('a refusal keeps whatever partial text the model produced before declining', () => {
  const outcome = turnStopOutcome({ stopReason: 'refusal', text: 'Partial answer before refusing.' })
  assert.equal(outcome.capped, 'model_refusal')
  assert.equal((outcome as { finalText: string }).finalText, 'Partial answer before refusing.')
})

test('max_tokens truncation is not a clean turn — capped as incomplete', () => {
  const outcome = turnStopOutcome({ stopReason: 'max_tokens', text: 'cut off mid-' })
  assert.equal(outcome.capped, 'model_incomplete')
  assert.equal((outcome as { finalText: string }).finalText, 'cut off mid-')
})

test('pause_turn (unresumed server-tool pause) is not a clean turn — capped as incomplete', () => {
  const outcome = turnStopOutcome({ stopReason: 'pause_turn', text: '' })
  assert.equal(outcome.capped, 'model_incomplete')
  assert.match((outcome as { finalText: string }).finalText, /incomplete/i)
})

test('end_turn is a clean turn — not capped', () => {
  assert.deepEqual(turnStopOutcome({ stopReason: 'end_turn', text: 'All done.' }), { capped: null })
})

test('tool_use is a clean turn — not capped (the loop dispatches the tool calls)', () => {
  assert.deepEqual(turnStopOutcome({ stopReason: 'tool_use', text: '' }), { capped: null })
})

test('the first turn of a run gets high effort', () => {
  assert.equal(turnEffortFor(0, 0), 'high')
})

test('the first turn of a resumed segment (startTurn > 0) also gets high effort', () => {
  assert.equal(turnEffortFor(5, 5), 'high')
})

test('turns after the first get medium effort', () => {
  assert.equal(turnEffortFor(1, 0), 'medium')
  assert.equal(turnEffortFor(6, 5), 'medium')
})
