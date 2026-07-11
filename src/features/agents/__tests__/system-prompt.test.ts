import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentSystemPrompt } from '../system-prompt.js'

describe('buildAgentSystemPrompt', () => {
  it('embeds the raw objective and adds no skill block when none are attached', () => {
    const prompt = buildAgentSystemPrompt('Summarize the weekly sales pipeline.', [])
    assert.ok(prompt.includes('Summarize the weekly sales pipeline.'))
    assert.ok(!prompt.includes('## Attached skill:'))
  })

  it('composes an attached (community) skill into the system prompt (the gap that scheduled runs missed)', () => {
    const extra = {
      id: 'community-skill-1',
      name: 'Pipeline Summary',
      instructions: 'Summarize the pipeline with per-account risk and next steps, grounded in retrieved data.',
    }
    const prompt = buildAgentSystemPrompt('Do the work.', [extra.id], [extra])
    assert.ok(prompt.includes('Do the work.'))
    assert.ok(prompt.includes(`## Attached skill: ${extra.name}`))
    assert.ok(prompt.includes(extra.instructions.slice(0, 40)))
  })

  it('ignores unknown skill ids without throwing', () => {
    const prompt = buildAgentSystemPrompt('Objective.', ['does-not-exist'])
    assert.ok(prompt.includes('Objective.'))
    assert.ok(!prompt.includes('## Attached skill:'))
  })
})
