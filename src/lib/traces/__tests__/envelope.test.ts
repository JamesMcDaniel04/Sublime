import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAgentStatus, normalizeFlowStatus, fmtDurationMs, costUsdOf } from '../envelope'

test('agent status table', () => {
  assert.equal(normalizeAgentStatus('pending', null), 'queued')
  assert.equal(normalizeAgentStatus('running', null), 'running')
  assert.equal(normalizeAgentStatus('waiting_for_input', null), 'waiting')
  assert.equal(normalizeAgentStatus('completed', new Date()), 'succeeded')
  assert.equal(normalizeAgentStatus('failed', new Date()), 'failed')
  assert.equal(normalizeAgentStatus('cancelled', new Date()), 'stopped')
  assert.equal(normalizeAgentStatus('cancelling', null), 'stopped')
})

test('unknown agent status degrades by terminal-ness, never throws', () => {
  assert.equal(normalizeAgentStatus('someday_new_status', null), 'running')
  assert.equal(normalizeAgentStatus('someday_new_status', new Date()), 'failed')
})

test('flow status table', () => {
  assert.equal(normalizeFlowStatus('queued', null), 'queued')
  assert.equal(normalizeFlowStatus('claimed', null), 'queued')
  assert.equal(normalizeFlowStatus('running', null), 'running')
  assert.equal(normalizeFlowStatus('waiting', null), 'waiting')
  assert.equal(normalizeFlowStatus('succeeded', new Date()), 'succeeded')
  assert.equal(normalizeFlowStatus('failed', new Date()), 'failed')
  assert.equal(normalizeFlowStatus('stopping', null), 'stopped')
  assert.equal(normalizeFlowStatus('stopped', new Date()), 'stopped')
  assert.equal(normalizeFlowStatus('brand_new', null), 'running')
  assert.equal(normalizeFlowStatus('brand_new', new Date()), 'failed')
})

test('fmtDurationMs', () => {
  assert.equal(fmtDurationMs(null), '—')
  assert.equal(fmtDurationMs(840), '840ms')
  assert.equal(fmtDurationMs(4200), '4.2s')
  assert.equal(fmtDurationMs(192_000), '3m 12s')
  assert.equal(fmtDurationMs(3_840_000), '1h 4m')
})

test('costUsdOf', () => {
  assert.equal(costUsdOf(600_000, 400_000, 10), 10)
  assert.equal(costUsdOf(0, 0, 10), 0)
})
