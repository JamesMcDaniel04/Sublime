import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSkill, listSkills } from '../compose'

test('built-in skill catalogue contains 20 unique agent enhancers', () => {
  const skills = listSkills()
  assert.equal(skills.length, 20)
  assert.equal(new Set(skills.map((skill) => skill.id)).size, 20)
})

test('built-in skills are instruction-only and do not require integrations', () => {
  for (const summary of listSkills()) {
    assert.deepEqual(summary.integrations, [], `${summary.id} must remain tool-independent`)
    const skill = getSkill(summary.id)
    assert.ok(skill?.instructions.trim(), `${summary.id} needs instructions`)
    assert.ok(skill!.instructions.length <= 1_200, `${summary.id} should stay a small instruction enhancer`)
  }
})
