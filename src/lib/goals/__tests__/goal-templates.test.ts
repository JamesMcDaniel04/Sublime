import assert from 'node:assert/strict'
import test from 'node:test'
import { GOAL_TEMPLATES, goalTemplateByKey } from '../goal-templates'
import { GOAL_KIND_LABELS, GOAL_KIND_UNITS } from '@/lib/types'
import { PRODUCT_DEPARTMENTS } from '@/lib/templates/departments'

test('catalogue shape: 4 per served department, 2 org + 2 personal', () => {
  assert.equal(GOAL_TEMPLATES.length, PRODUCT_DEPARTMENTS.length * 4)
  for (const department of PRODUCT_DEPARTMENTS) {
    const entries = GOAL_TEMPLATES.filter((entry) => entry.department === department)
    assert.equal(entries.length, 4, `${department} should have 4 templates`)
    assert.equal(entries.filter((entry) => entry.scope === 'org').length, 2, `${department} org split`)
    assert.equal(entries.filter((entry) => entry.scope === 'personal').length, 2, `${department} personal split`)
  }
})

test('every template has a valid kind, a kind-consistent unit, and a unique key', () => {
  const keys = new Set<string>()
  for (const entry of GOAL_TEMPLATES) {
    assert.ok(entry.kind in GOAL_KIND_LABELS, `${entry.key}: unknown kind ${entry.kind}`)
    const implied = GOAL_KIND_UNITS[entry.kind]
    if (implied !== null) assert.equal(entry.unit, implied, `${entry.key}: unit contradicts kind`)
    assert.ok(!keys.has(entry.key), `duplicate key ${entry.key}`)
    keys.add(entry.key)
    assert.ok(entry.name.length > 0 && entry.description.length > 0)
  }
})

test('savings templates trend down; lookup by key round-trips', () => {
  for (const entry of GOAL_TEMPLATES.filter((candidate) => candidate.kind === 'savings')) {
    assert.equal(entry.direction, 'decrease', entry.key)
  }
  assert.equal(goalTemplateByKey('sales-personal-quota')?.kind, 'quota')
  assert.equal(goalTemplateByKey('no-such-template'), null)
})
