import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReflection, buildReflectionPrompt, countActionableToolCalls } from '../reflection'

test('parseReflection accepts clean JSON', () => {
  const parsed = parseReflection(JSON.stringify({
    learnings: [{ title: 'Snowflake table', content: 'Upsell data lives in ANALYTICS.UPSELL' }],
    selfCritique: 'Query Snowflake before Salesforce next time.',
    suggestions: [{ title: 'Connect Salesforce', rationale: 'SOQL segmentation needs it', actionType: 'connect' }],
    goalContribution: { verdict: 'advanced', evidence: 'Scored 12 accounts feeding the pipeline metric.' },
  }))
  assert.equal(parsed?.learnings[0].title, 'Snowflake table')
  assert.equal(parsed?.suggestions[0].actionType, 'connect')
  assert.equal(parsed?.goalContribution.verdict, 'advanced')
})

test('parseReflection defaults a missing or invalid contribution verdict to unclear', () => {
  const missing = parseReflection(JSON.stringify({ learnings: [], selfCritique: '', suggestions: [] }))
  assert.deepEqual(missing?.goalContribution, { verdict: 'unclear', evidence: '' })
  const invalid = parseReflection(JSON.stringify({
    learnings: [], selfCritique: '', suggestions: [],
    goalContribution: { verdict: 'amazing', evidence: 'nope' },
  }))
  assert.equal(invalid?.goalContribution.verdict, 'unclear')
})

test('parseReflection tolerates code fences and drops invalid actionType', () => {
  const fenced = '```json\n' + JSON.stringify({
    learnings: [], selfCritique: 'ok', suggestions: [{ title: 'x', rationale: 'y', actionType: 'weird' }],
  }) + '\n```'
  const parsed = parseReflection(fenced)
  assert.equal(parsed?.suggestions[0].actionType, 'other')
})

test('parseReflection returns null on garbage', () => {
  assert.equal(parseReflection('not json at all'), null)
  assert.equal(parseReflection('{"learnings": "nope"}'), null)
})

test('buildReflectionPrompt includes goal, objective, summary, log', () => {
  const { system, user } = buildReflectionPrompt({
    goal: 'Grow upsell pipeline', objective: 'Score accounts', summary: 'Scored 12 accounts', processLog: 'tool: search…',
  })
  assert.match(system, /reflection/i)
  assert.match(user, /Grow upsell pipeline/)
  assert.match(user, /Score accounts/)
  assert.match(user, /Scored 12 accounts/)
  assert.match(system, /verdict/i)
})

test('buildReflectionPrompt surfaces plan-audit findings when present', () => {
  const { user } = buildReflectionPrompt({
    goal: null, objective: 'x', summary: 'y', processLog: 'z',
    planFindings: ['failed_step_no_revision'],
  })
  assert.match(user, /failed_step_no_revision/)
  const { user: without } = buildReflectionPrompt({ goal: null, objective: 'x', summary: 'y', processLog: 'z' })
  assert.ok(!without.includes('Plan audit'))
})

test('countActionableToolCalls: ask_user alone does not count as actionable', () => {
  const processLog = 'assistant: let me check\ntool: ask_user'
  assert.equal(countActionableToolCalls(processLog), 0)
})

test('countActionableToolCalls: a real tool alongside ask_user counts only the real one', () => {
  const processLog = 'tool: ask_user\ntool: github_search'
  assert.equal(countActionableToolCalls(processLog), 1)
})

test('countActionableToolCalls: multiple real tools all count', () => {
  const processLog = 'tool: github_search\ntool: snowflake_query\ntool: ask_user'
  assert.equal(countActionableToolCalls(processLog), 2)
})

test('countActionableToolCalls: empty log counts zero', () => {
  assert.equal(countActionableToolCalls(''), 0)
})

test('reflectAndRemember calls generate with the built prompt and tolerates downstream failure', async () => {
  const { reflectAndRemember } = await import('../reflection')
  let captured: { system: string; user: string; model?: string } | null = null
  const result = await reflectAndRemember(
    {
      organizationId: 'org', agentId: 'agent', executionId: 'exec',
      goal: null, objective: 'obj', summary: 'sum', processLog: 'log',
      recordSuggestionEvent: async () => undefined,
    },
    {
      generate: async (opts) => {
        captured = { system: opts.system, user: opts.user, model: opts.model }
        throw new Error('stop before DB writes')
      },
    },
  )
  assert.equal(result, null)
  assert.match(captured!.user, /infer one/)
  assert.equal(typeof captured!.model, 'string')
  assert.ok(captured!.model && captured!.model.length > 0, 'reflection should request the cheap model tier')
})
