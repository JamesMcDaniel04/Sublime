import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AUTHORING_SAFETY, inlineAgentSystem } from '@/lib/llm/guardrails'
import { graphRules } from '@/lib/flows/copilot-grounding'

/**
 * Safety language existed only in the agent RUN prompt. Everything that
 * AUTHORS an artifact — the flow copilot, the NL agent builder, the home
 * assistant, and a flow's inline-prompt agent node — had a purely mechanical
 * prompt, so a well-formed graph for impersonation or bulk unsolicited
 * outreach passed schema validation with nothing objecting.
 */

test('the preamble refuses the artifact classes we care about', () => {
  const text = AUTHORING_SAFETY.toLowerCase()
  for (const topic of ['impersonat', 'deceiv', 'harass', 'unsolicited', 'credential']) {
    assert.ok(text.includes(topic), `preamble does not address "${topic}"`)
  }
})

test('the preamble keeps authoring inside the workspace and its stated purpose', () => {
  const text = AUTHORING_SAFETY.toLowerCase()
  assert.ok(text.includes('workspace'))
  assert.ok(text.includes('refuse'))
})

test('the flow copilot graph rules carry the preamble', () => {
  assert.ok(graphRules.includes(AUTHORING_SAFETY), 'flow copilot can author graphs with no safety language')
})

test('an inline agent node prompt is prefixed with the preamble', () => {
  const system = inlineAgentSystem('Summarize the input in one line.')
  assert.ok(system.startsWith(AUTHORING_SAFETY), 'author-supplied prompt became the entire system prompt')
  assert.ok(system.includes('Summarize the input in one line.'))
})

test('an empty inline prompt still carries the preamble', () => {
  assert.ok(inlineAgentSystem('').includes(AUTHORING_SAFETY))
  assert.ok(inlineAgentSystem(undefined).includes(AUTHORING_SAFETY))
})

/**
 * Structural guard, in the spirit of route-permissions.test.ts: a NEW
 * generation surface that forgets the preamble should fail CI rather than ship
 * an unguarded prompt.
 */
const GENERATION_SURFACES = [
  'src/app/api/assistant/chat/route.ts',
  'src/app/api/agents/draft/route.ts',
  'src/lib/flows/copilot-grounding.ts',
  'src/features/flows/execute-flow.ts',
]

for (const file of GENERATION_SURFACES) {
  test(`${file} references the shared authoring preamble`, () => {
    const source = readFileSync(file, 'utf8')
    assert.match(
      source,
      /AUTHORING_SAFETY|inlineAgentSystem/,
      `${file} builds a generation prompt without the shared safety preamble`,
    )
  })
}
