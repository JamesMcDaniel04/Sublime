import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentSystemPrompt } from '../system-prompt.js'
import { getSkill, listSkills } from '../../../lib/skills/compose.js'

describe('buildAgentSystemPrompt', () => {
  it('embeds the raw objective and adds no skill block when none are attached', () => {
    const prompt = buildAgentSystemPrompt('Summarize the weekly sales pipeline.', [])
    assert.ok(prompt.includes('Summarize the weekly sales pipeline.'))
    assert.ok(!prompt.includes('## Attached skill:'))
  })

  it('composes an attached skill into the system prompt (the gap that scheduled runs missed)', () => {
    const fixture = listSkills()[0]
    assert.ok(fixture, 'expected at least one bundled skill to test against')
    const skill = getSkill(fixture.id)
    assert.ok(skill, 'fixture skill should resolve with instructions')

    const prompt = buildAgentSystemPrompt('Do the work.', [fixture.id])
    assert.ok(prompt.includes('Do the work.'))
    assert.ok(prompt.includes(`## Attached skill: ${skill!.name}`))
    assert.ok(prompt.includes(skill!.instructions.slice(0, 40)))
  })

  it('ignores unknown skill ids without throwing', () => {
    const prompt = buildAgentSystemPrompt('Objective.', ['does-not-exist'])
    assert.ok(prompt.includes('Objective.'))
    assert.ok(!prompt.includes('## Attached skill:'))
  })
})
