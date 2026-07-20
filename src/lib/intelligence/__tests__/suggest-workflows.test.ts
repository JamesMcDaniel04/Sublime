import { test } from 'node:test'
import assert from 'node:assert/strict'
import { meetsSuggestionGate, parseSuggestions, buildSynthesisPrompt, FLOW_TARGET_MARKER_PREFIX } from '../suggest-workflows'

test('meetsSuggestionGate: below 3 total connections is not met', () => {
  assert.equal(meetsSuggestionGate({ nango: 0, mcp: 0 }), false)
  assert.equal(meetsSuggestionGate({ nango: 1, mcp: 0 }), false)
  assert.equal(meetsSuggestionGate({ nango: 2, mcp: 0 }), false)
})

test('meetsSuggestionGate: exactly 3 total (any split) is met', () => {
  assert.equal(meetsSuggestionGate({ nango: 3, mcp: 0 }), true)
  assert.equal(meetsSuggestionGate({ nango: 2, mcp: 1 }), true)
  assert.equal(meetsSuggestionGate({ nango: 0, mcp: 3 }), true)
})

test('meetsSuggestionGate: more than 3 total is met', () => {
  assert.equal(meetsSuggestionGate({ nango: 4, mcp: 2 }), true)
})

test('parseSuggestions: parses well-formed JSON', () => {
  const raw = JSON.stringify({
    suggestions: [{ title: 'Weekly GitHub digest', description: 'Summarize issues to Slack', flowPrompt: 'Every Monday, summarize new GitHub issues into a Slack message.' }],
    improvements: [{ targetType: 'flow', targetId: 'flow_1', title: 'Add schedule', rationale: 'This flow is run manually every week.' }],
  })
  const parsed = parseSuggestions(raw)
  assert.ok(parsed)
  assert.equal(parsed!.suggestions.length, 1)
  assert.equal(parsed!.suggestions[0].title, 'Weekly GitHub digest')
  assert.equal(parsed!.improvements.length, 1)
  assert.equal(parsed!.improvements[0].targetType, 'flow')
})

test('parseSuggestions: strips a ```json fence', () => {
  const inner = JSON.stringify({ suggestions: [], improvements: [] })
  const raw = `Here you go:\n\`\`\`json\n${inner}\n\`\`\``
  const parsed = parseSuggestions(raw)
  assert.ok(parsed)
  assert.deepEqual(parsed!.suggestions, [])
  assert.deepEqual(parsed!.improvements, [])
})

test('parseSuggestions: defaults missing arrays to []', () => {
  const parsed = parseSuggestions(JSON.stringify({}))
  assert.ok(parsed)
  assert.deepEqual(parsed!.suggestions, [])
  assert.deepEqual(parsed!.improvements, [])
})

test('parseSuggestions: rejects an improvement with an invalid targetType', () => {
  const raw = JSON.stringify({
    suggestions: [],
    improvements: [{ targetType: 'workflow', targetId: 'x', title: 't', rationale: 'r' }],
  })
  assert.equal(parseSuggestions(raw), null)
})

test('parseSuggestions: null on garbage input', () => {
  assert.equal(parseSuggestions('not json at all'), null)
  assert.equal(parseSuggestions(''), null)
})

test('FLOW_TARGET_MARKER_PREFIX: stable marker shape', () => {
  assert.equal(FLOW_TARGET_MARKER_PREFIX, 'flow:')
})

test('buildSynthesisPrompt includes the persona block only when provided', () => {
  const base = { profiles: [{ title: 't', content: 'c' }], flows: [], agents: [] }
  const without = buildSynthesisPrompt(base)
  assert.ok(!without.user.includes('Organization persona'))
  const withPersona = buildSynthesisPrompt({ ...base, persona: { departments: ['engineering'], narrative: 'Ships fast.' } })
  assert.ok(withPersona.user.includes('Organization persona'))
  assert.ok(withPersona.user.includes('engineering'))
  assert.ok(withPersona.user.includes('Ships fast.'))
  assert.ok(withPersona.system.toLowerCase().includes('persona'))
})
