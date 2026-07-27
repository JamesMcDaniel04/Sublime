import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GOAL_TEMPLATES } from '@/lib/goals/goal-templates'
import { getSeedByKey } from '@/lib/templates/catalogue'

test('every curated seedKey resolves to a real seed', () => {
  for (const template of GOAL_TEMPLATES) {
    for (const seedKey of template.agents) {
      assert.ok(
        getSeedByKey(seedKey),
        `${template.key} references unknown seed "${seedKey}"`,
      )
    }
  }
})

test("curated agents come from the goal template's own department", () => {
  for (const template of GOAL_TEMPLATES) {
    for (const seedKey of template.agents) {
      const seed = getSeedByKey(seedKey)!
      assert.ok(
        seed.departments.includes(template.department),
        `${template.key} (${template.department}) curates ${seedKey}, which serves ${seed.departments.join('|')}`,
      )
    }
  }
})

test('agents is present on every template, so an empty list is deliberate', () => {
  for (const template of GOAL_TEMPLATES) {
    assert.ok(Array.isArray(template.agents), `${template.key} has no agents field`)
  }
  // Curation is intentionally partial, but a mostly-empty catalogue would mean
  // the curation step was skipped rather than considered.
  const curated = GOAL_TEMPLATES.filter((template) => template.agents.length > 0)
  assert.ok(
    curated.length >= 40,
    `only ${curated.length} of ${GOAL_TEMPLATES.length} templates are curated`,
  )
})

test('no template curates the same seed twice', () => {
  for (const template of GOAL_TEMPLATES) {
    assert.equal(
      new Set(template.agents).size,
      template.agents.length,
      `${template.key} lists a duplicate seed`,
    )
  }
})
