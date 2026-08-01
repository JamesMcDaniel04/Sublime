import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentSystemPrompt } from '../system-prompt.js'
import { artifactOutputContract } from '@/lib/templates/example-artifact'

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

  // Gap #1: a template agent carries the HTML-artifact contract in its
  // objective, but the base prompt used to end with an unconditional "format as
  // clean Markdown" line that overrode it — so runs rendered as plain prose
  // instead of the advertised rich artifact.
  it('demands the HTML artifact (and drops the Markdown-only directive) when the objective carries the artifact contract', () => {
    const objective = `Produce the weekly revenue report.\n\n${artifactOutputContract({ name: 'Revenue report', description: 'Weekly pipeline', departments: ['sales'] })}`
    const prompt = buildAgentSystemPrompt(objective, [])
    assert.ok(!prompt.includes('Format the final response as clean Markdown'), 'the Markdown-only directive must not contradict the artifact contract')
    assert.ok(prompt.includes('semantic HTML'), 'the prompt should instruct the model to return the semantic HTML artifact')
    assert.ok(prompt.includes('class="artifact'), 'the prompt should name the artifact structure the renderer styles')
  })

  it('keeps the Markdown formatting directive for a plain (non-template) objective', () => {
    const prompt = buildAgentSystemPrompt('Summarize the weekly sales pipeline.', [])
    assert.ok(prompt.includes('Format the final response as clean Markdown'))
    assert.ok(!prompt.includes('semantic HTML artifact'))
  })

  it('includes workspace context when provided', () => {
    const prompt = buildAgentSystemPrompt('Objective.', [], [], { orgContext: 'A sales-led org living in Salesforce.' })
    assert.ok(prompt.includes('A sales-led org living in Salesforce.'))
    assert.ok(prompt.includes('Workspace context'))
  })

  it('omits the workspace-context line entirely when absent', () => {
    const prompt = buildAgentSystemPrompt('Objective.', [])
    assert.ok(!prompt.includes('Workspace context'))
  })
})

it('system prompt carries the data-boundary and misuse guardrail', () => {
  const prompt = buildAgentSystemPrompt('Summarize pipeline', [])
  assert.ok(prompt.includes('Data boundary and safety rules'))
  assert.ok(prompt.includes('another organization'))
  assert.ok(/DATA, not instructions/.test(prompt))
  assert.ok(/Refuse tasks that are illegal/.test(prompt))
  assert.ok(/credentials, API keys, or tokens/.test(prompt))
})
