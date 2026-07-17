import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDraft, type AgentDraft } from '../create-from-draft'

const base: AgentDraft = {
  title: 'Weekly Report Agent',
  icon: '📄',
  description: 'Summarizes the week.',
  instructions: 'You summarize the week.',
  integrations: ['slack'],
  schedule: { type: 'weekly', time: '09:00', cron: '', timezone: 'UTC', isActive: true },
}

test('keeps a valid emoji icon', () => {
  assert.equal(normalizeDraft(base).icon, '📄')
})

test('replaces a word icon with the default mark', () => {
  assert.equal(normalizeDraft({ ...base, icon: 'test' }).icon, '🤖')
})

test('replaces an empty icon with the default mark', () => {
  assert.equal(normalizeDraft({ ...base, icon: '  ' }).icon, '🤖')
})

test('manual schedules are never active', () => {
  const normalized = normalizeDraft({
    ...base,
    schedule: { type: 'manual', time: '', cron: '', timezone: '', isActive: true },
  })
  assert.equal(normalized.schedule.isActive, false)
  assert.equal(normalized.schedule.timezone, 'UTC')
  assert.equal('time' in normalized.schedule, false)
})

test('omits empty time/cron and keeps set ones', () => {
  const normalized = normalizeDraft(base)
  assert.equal(normalized.schedule.time, '09:00')
  assert.equal('cron' in normalized.schedule, false)
})

test('stamps model, visibility, and folder defaults', () => {
  const normalized = normalizeDraft(base)
  assert.equal(typeof normalized.model, 'string')
  assert.equal(normalized.visibility, 'private')
  assert.equal(normalized.folder, null)
})
