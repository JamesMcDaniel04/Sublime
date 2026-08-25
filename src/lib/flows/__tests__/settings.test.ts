/**
 * Flow-level settings.
 *
 * n8n's `IWorkflowSettings` carries 18 fields; Sublime had two, and one of
 * them (`errorFlowId`) lives untyped inside `Flow.metadata` with each reader
 * re-deriving it. This gives that grab-bag a typed reader so a setting is
 * declared once.
 *
 * `timezone` is the first addition and it is a correctness fix, not a
 * preference: a schedule trigger and a `{{today}}` token both currently
 * resolve against whatever zone the server happens to run in, so the same flow
 * produces different results depending on where it is deployed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowSettings, isValidTimezone } from '../settings'

test('an absent metadata bag yields defaults, not undefined', () => {
  const settings = flowSettings(null)
  assert.equal(settings.timezone, 'UTC')
  assert.equal(settings.errorFlowId, undefined)
})

test('timezone defaults to UTC, never the server zone', () => {
  assert.equal(flowSettings({}).timezone, 'UTC')
})

test('a valid IANA zone is kept', () => {
  assert.equal(flowSettings({ timezone: 'Europe/Berlin' }).timezone, 'Europe/Berlin')
})

// A typo must not fail every run of the flow; it must degrade to the
// documented default the same way an absent value does.
test('an invalid zone falls back to UTC rather than breaking the run', () => {
  assert.equal(flowSettings({ timezone: 'Mars/Olympus' }).timezone, 'UTC')
  assert.equal(flowSettings({ timezone: 42 }).timezone, 'UTC')
  assert.equal(flowSettings({ timezone: '' }).timezone, 'UTC')
})

test('errorFlowId still reads out of the same bag', () => {
  assert.equal(flowSettings({ errorFlowId: 'flow_123' }).errorFlowId, 'flow_123')
  assert.equal(flowSettings({ errorFlowId: '' }).errorFlowId, undefined)
})

// The metadata column is Json and carries unrelated keys (behavioural
// provenance among them); reading it must not disturb or depend on them.
test('unrelated metadata keys are ignored, not lost', () => {
  const settings = flowSettings({ provenance: 'suggested', timezone: 'Asia/Tokyo' })
  assert.equal(settings.timezone, 'Asia/Tokyo')
})

test('a non-object metadata value is treated as empty', () => {
  assert.equal(flowSettings('nonsense' as unknown as Record<string, unknown>).timezone, 'UTC')
  assert.equal(flowSettings([] as unknown as Record<string, unknown>).timezone, 'UTC')
})

test('isValidTimezone accepts real zones and rejects nonsense', () => {
  assert.equal(isValidTimezone('America/New_York'), true)
  assert.equal(isValidTimezone('UTC'), true)
  assert.equal(isValidTimezone('Not/AZone'), false)
  assert.equal(isValidTimezone(''), false)
  assert.equal(isValidTimezone(undefined), false)
})
