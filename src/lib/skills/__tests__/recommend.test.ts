import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recommendTemplatesForSkill } from '../recommend'
import { SEED_CATALOGUE } from '@/lib/templates/catalogue'

test('skill recommendations are deterministic, bounded, and return real templates', () => {
  const skill = {
    name: 'Incident Update Writer',
    description: 'Writes factual incident status updates',
    category: 'Communication',
    audience: ['engineering'],
    tags: ['incident', 'status'],
  }
  const first = recommendTemplatesForSkill(skill, SEED_CATALOGUE, 4)
  const second = recommendTemplatesForSkill(skill, SEED_CATALOGUE, 4)
  assert.equal(first.length, 4)
  assert.deepEqual(first.map((item) => item.seedKey), second.map((item) => item.seedKey))
  assert.ok(first.some((item) => /incident|handoff|brief|update/i.test(`${item.name} ${item.description}`)))
})
