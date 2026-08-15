import { test } from 'node:test'
import assert from 'node:assert/strict'
import { traceFromAgentExecution, traceFromFlowRun } from '../spans'

const execution = {
  id: 'e1', status: 'completed',
  startedAt: '2026-08-14T00:00:00Z', completedAt: '2026-08-14T00:01:00Z',
  inputTokens: 900_000, outputTokens: 100_000, error: null, trigger: { type: 'manual' },
}

test('agent: events and steps interleave chronologically; summary math', () => {
  const events = [
    { id: 'ev1', kind: 'agent.thinking', payload: { text: 'hm' }, ts: '2026-08-14T00:00:10Z' },
    { id: 'ev2', kind: 'context.retrieved', payload: { summary: 's', hits: [], related: [] }, ts: '2026-08-14T00:00:05Z' },
  ]
  const steps = [{ id: 's1', node: 'slack.send', status: 'succeeded', startedAt: '2026-08-14T00:00:20Z' }]
  const detail = traceFromAgentExecution(execution, events, steps, { name: 'Renewal agent', perMTokensUsd: 10 })
  assert.deepEqual(detail.spans.map((s) => s.kind), ['retrieval', 'thinking', 'tool'])
  assert.equal(detail.summary.status, 'succeeded')
  assert.equal(detail.summary.costUsd, 10)
  assert.equal(detail.summary.toolCallCount, 1)
  assert.equal(detail.summary.hasRetrieval, true)
  assert.equal(detail.summary.durationMs, 60_000)
  assert.equal(detail.summary.name, 'Renewal agent')
  assert.equal(detail.summary.trigger, 'manual')
})

test('agent: legacy context.retrieved (no stages) maps with nulls, not throws', () => {
  const events = [{ id: 'ev', kind: 'context.retrieved', payload: { summary: 's', hits: [{ type: 't', text: 'x' }], related: [] }, ts: '2026-08-14T00:00:05Z' }]
  const detail = traceFromAgentExecution(execution, events, [], { name: 'a', perMTokensUsd: 10 })
  const span = detail.spans[0]
  assert.equal(span.kind, 'retrieval')
  if (span.kind === 'retrieval') {
    assert.equal(span.stages, null)
    assert.equal(span.query, null)
    assert.equal(span.hits[0].score, null)
    assert.equal(span.channel, 'graph-rag')
  }
})

test('agent: enriched retrieval and knowledge events carry funnel + scores', () => {
  const stages = {
    candidates: 12, afterScoreFloor: 7, reranked: true, afterRerank: 5,
    graphSeeds: 5, relatedFound: 9, relatedKept: 4, minScore: 0.25, topK: 6, hops: 2,
  }
  const events = [
    {
      id: 'ev1', kind: 'context.retrieved', ts: '2026-08-14T00:00:05Z',
      payload: {
        summary: 's', strategy: 'vector+rerank+graph', query: 'renewal risk',
        hits: [{ type: 'opportunity', text: 'Acme', score: 0.87 }], related: [],
        stages, injected: { count: 1, ofCandidates: 5, tokens: 2100 },
      },
    },
    {
      id: 'ev2', kind: 'knowledge.retrieved', ts: '2026-08-14T00:00:06Z',
      payload: {
        summary: 'k', query: 'renewal risk',
        chunks: [{ filename: 'deck.pdf', score: 0.8 }],
        injected: { count: 1, ofCandidates: 6, tokens: 500 },
      },
    },
  ]
  const detail = traceFromAgentExecution(execution, events, [], { name: 'a', perMTokensUsd: 10 })
  const [rag, knowledge] = detail.spans
  assert.equal(rag.kind, 'retrieval')
  if (rag.kind === 'retrieval') {
    assert.equal(rag.strategy, 'vector+rerank+graph')
    assert.equal(rag.query, 'renewal risk')
    assert.equal(rag.hits[0].score, 0.87)
    assert.deepEqual(rag.stages, stages)
    assert.equal(rag.injected?.tokens, 2100)
  }
  assert.equal(knowledge.kind, 'retrieval')
  if (knowledge.kind === 'retrieval') {
    assert.equal(knowledge.channel, 'knowledge')
    assert.equal(knowledge.hits[0].text, 'deck.pdf')
    assert.equal(knowledge.hits[0].score, 0.8)
  }
})

test('agent: malformed payload becomes a span, never throws', () => {
  const events = [{ id: 'ev', kind: 'agent.thinking', payload: 'not-an-object' as never, ts: 'garbage-date' }]
  const detail = traceFromAgentExecution(execution, events, [], { name: 'a', perMTokensUsd: 10 })
  assert.equal(detail.spans.length, 1)
})

test('flow: steps order by (order, iterationPath); effects attach; subagent nests', () => {
  const run = { id: 'r1', status: 'succeeded', startedAt: '2026-08-14T00:00:00Z', finishedAt: '2026-08-14T00:02:00Z', error: null, trigger: { type: 'schedule' } }
  const steps = [
    { id: 'st2', nodeId: 'loop.body', agentExecutionId: null, iterationPath: '1', order: 2, status: 'succeeded', error: null, startedAt: null, finishedAt: null },
    { id: 'st1', nodeId: 'loop.body', agentExecutionId: null, iterationPath: '0', order: 2, status: 'succeeded', error: null, startedAt: null, finishedAt: null },
    { id: 'st0', nodeId: 'agent.step', agentExecutionId: 'e1', iterationPath: null, order: 1, status: 'succeeded', error: null, startedAt: null, finishedAt: null },
  ]
  const effects = [{ flowRunStepId: 'st1', provider: 'slack', operation: 'send_message', safety: 'unsafe_write', status: 'succeeded', attempts: 1 }]
  const child = traceFromAgentExecution(execution, [], [], { name: 'child', perMTokensUsd: 10 })
  const detail = traceFromFlowRun(run, steps, effects, new Map([['e1', child]]), { name: 'My flow' })
  assert.deepEqual(detail.spans.map((s) => s.kind), ['subagent', 'step', 'step'])
  const first = detail.spans[1]
  if (first.kind === 'step') {
    assert.equal(first.iterationPath, '0')
    assert.equal(first.effects[0].provider, 'slack')
  }
  assert.deepEqual(detail.summary.tokens, { input: 900_000, output: 100_000 })
  assert.equal(detail.summary.costUsd, 10)
  assert.equal(detail.summary.status, 'succeeded')
  assert.equal(detail.summary.trigger, 'schedule')
  assert.equal(detail.summary.toolCallCount, 3)
})

test('flow: pruned child (id not in map) falls back to a plain step span', () => {
  const run = { id: 'r1', status: 'succeeded', startedAt: '2026-08-14T00:00:00Z', finishedAt: null, error: null, trigger: null }
  const steps = [{ id: 'st', nodeId: 'agent.step', agentExecutionId: 'gone', iterationPath: null, order: 1, status: 'succeeded', error: null, startedAt: null, finishedAt: null }]
  const detail = traceFromFlowRun(run, steps, [], new Map(), { name: 'f' })
  assert.equal(detail.spans[0].kind, 'step')
  assert.equal(detail.summary.tokens, null)
  assert.equal(detail.summary.costUsd, null)
})
