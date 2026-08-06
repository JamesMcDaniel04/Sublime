import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyGraph } from '../graph'
import { parseCopilotChatReply, sanitizeCopilotOps, discardNotice } from '../copilot-chat'

const context = { agents: [{ id: 'agent-1' }], toolCatalog: [] }

test('parseCopilotChatReply reads the {message, opsJson} wrapper', () => {
  const raw = JSON.stringify({ message: 'Added a step.', opsJson: JSON.stringify([{ op: 'delete', id: 'n1' }]) })
  const reply = parseCopilotChatReply(raw)
  assert.equal(reply.message, 'Added a step.')
  assert.deepEqual(reply.candidates, [{ op: 'delete', id: 'n1' }])
  assert.equal(reply.opsUnreadable, false)
})

test('parseCopilotChatReply strips ```json fences from opsJson', () => {
  const raw = JSON.stringify({ message: 'ok', opsJson: '```json\n[{"op":"delete","id":"n1"}]\n```' })
  const reply = parseCopilotChatReply(raw)
  assert.deepEqual(reply.candidates, [{ op: 'delete', id: 'n1' }])
  assert.equal(reply.opsUnreadable, false)
})

test('parseCopilotChatReply accepts a direct ops array and a bare op object', () => {
  const direct = parseCopilotChatReply(JSON.stringify({ message: 'hi', ops: [{ op: 'delete', id: 'n1' }] }))
  assert.deepEqual(direct.candidates, [{ op: 'delete', id: 'n1' }])
  const bare = parseCopilotChatReply(JSON.stringify({ message: 'hi', opsJson: '{"op":"delete","id":"n1"}' }))
  assert.deepEqual(bare.candidates, [{ op: 'delete', id: 'n1' }])
})

test('parseCopilotChatReply flags unreadable ops payloads', () => {
  assert.equal(parseCopilotChatReply('not json at all').opsUnreadable, true)
  assert.equal(parseCopilotChatReply(JSON.stringify({ message: 'x', opsJson: '{{nope' })).opsUnreadable, true)
  assert.equal(parseCopilotChatReply(JSON.stringify({ message: 'x', opsJson: '"just a string"' })).opsUnreadable, true)
  // A missing/empty ops payload is a normal no-change reply, not a failure.
  assert.equal(parseCopilotChatReply(JSON.stringify({ message: 'x' })).opsUnreadable, false)
  assert.equal(parseCopilotChatReply(JSON.stringify({ message: 'x', opsJson: '[]' })).opsUnreadable, false)
})

test('sanitizeCopilotOps keeps valid ops and counts invalid ones', () => {
  const { ops, discarded } = sanitizeCopilotOps(
    [
      { op: 'update', id: 'n1', data: { label: 'Renamed' } },
      { op: 'teleport', id: 'n1' },
      'garbage',
      { op: 'add', afterId: 'trigger' }, // missing required `type`
    ],
    context,
  )
  assert.equal(ops.length, 1)
  assert.deepEqual(ops[0], { op: 'update', id: 'n1', data: { label: 'Renamed' } })
  assert.equal(discarded, 3)
})

test('sanitizeCopilotOps attaches a server-sanitized graph to replace ops', () => {
  const graphJson = JSON.stringify(emptyGraph())
  const { ops, discarded } = sanitizeCopilotOps([{ op: 'replace', graphJson }], context)
  assert.equal(discarded, 0)
  assert.equal(ops.length, 1)
  const replace = ops[0]
  assert.equal(replace.op, 'replace')
  if (replace.op !== 'replace') return
  assert.ok(replace.graph)
  assert.ok(replace.graph!.nodes.some((node) => node.id === 'trigger'))
  // The echoed graphJson is the canonical serialization of the attached graph.
  assert.equal(replace.graphJson, JSON.stringify(replace.graph))
})

test('sanitizeCopilotOps ignores a model-supplied graph and drops bad graphJson', () => {
  const fake = { nodes: [], edges: [] }
  const good = sanitizeCopilotOps([{ op: 'replace', graphJson: JSON.stringify(emptyGraph()), graph: fake }], context)
  assert.equal(good.ops.length, 1)
  const replace = good.ops[0]
  assert.equal(replace.op, 'replace')
  if (replace.op !== 'replace') return
  // The wire schema strips the hallucinated graph; the attached one is server-built.
  assert.notEqual(replace.graph, fake)
  assert.ok(replace.graph!.nodes.length > 0)

  const bad = sanitizeCopilotOps([{ op: 'replace', graphJson: 'not valid json' }], context)
  assert.equal(bad.ops.length, 0)
  assert.equal(bad.discarded, 1)
})

test('sanitizeCopilotOps replace repair drops unknown agents from the graph', () => {
  const graphJson = JSON.stringify({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'a1', type: 'agent', data: { agentId: 'nope', label: 'Ghost' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a1' }],
  })
  const { ops } = sanitizeCopilotOps([{ op: 'replace', graphJson }], context)
  const replace = ops[0]
  assert.equal(replace.op, 'replace')
  if (replace.op !== 'replace') return
  assert.ok(!replace.graph!.nodes.some((node) => node.id === 'a1'))
})

test('discardNotice pluralizes correctly', () => {
  assert.equal(discardNotice(1), " (I discarded 1 change that didn't validate.)")
  assert.equal(discardNotice(3), " (I discarded 3 changes that didn't validate.)")
})

test('sanitizeDemoRun keeps only mocks for real node ids and parses input', async () => {
  const { sanitizeDemoRun } = await import('../copilot-chat')
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger' as const, data: { trigger: { type: 'manual' as const } } },
      { id: 'fetch', type: 'http' as const, data: { method: 'GET' as const, url: 'https://x.co' } },
      { id: 'send', type: 'tool' as const, data: { connectionId: 'nango:slack', toolName: 'slack_post_message' } },
    ],
    edges: [],
  }
  const demo = sanitizeDemoRun(
    JSON.stringify({ send: { ok: true, channel: '#leads' }, ghost: { nope: 1 } }),
    JSON.stringify({ channel: '#leads' }),
    graph,
  )
  assert.ok(demo)
  assert.deepEqual(Object.keys(demo!.mockOutputs), ['send'])
  assert.deepEqual(demo!.input, { channel: '#leads' })
})

test('sanitizeDemoRun rejects junk, oversized payloads, and empty mock sets', async () => {
  const { sanitizeDemoRun } = await import('../copilot-chat')
  const graph = { nodes: [{ id: 'trigger', type: 'trigger' as const, data: { trigger: { type: 'manual' as const } } }], edges: [] }
  assert.equal(sanitizeDemoRun('not json', undefined, graph), null)
  assert.equal(sanitizeDemoRun('[1,2,3]', undefined, graph), null)
  assert.equal(sanitizeDemoRun(JSON.stringify({ ghost: 1 }), undefined, graph), null)
  const huge = JSON.stringify({ trigger: 'x'.repeat(40_000) })
  assert.equal(sanitizeDemoRun(huge, undefined, graph), null)
})

test('parseCopilotChatReply surfaces demoMocksJson and demoInputJson strings', () => {
  const raw = JSON.stringify({ message: 'demo!', opsJson: '[]', demoMocksJson: '{"send":{"ok":true}}', demoInputJson: '{"a":1}' })
  const reply = parseCopilotChatReply(raw)
  assert.equal(reply.demoMocksJson, '{"send":{"ok":true}}')
  assert.equal(reply.demoInputJson, '{"a":1}')
})
