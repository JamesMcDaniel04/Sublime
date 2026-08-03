import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelRunner, ModelTurn, ToolDefinition, ToolResult } from '@/lib/llm/model-runner'
import { runCopilotLoop, type CopilotStreamEvent, type CopilotTool } from '@/lib/llm/copilot-loop'

const TERMINAL: ToolDefinition = { name: 'propose_config_change', description: 'terminal', inputSchema: { type: 'object' } }

function readTool(name: string, executor?: (input: Record<string, unknown>) => Promise<unknown>): CopilotTool {
  return {
    definition: { name, description: `read ${name}`, inputSchema: { type: 'object' } },
    label: (input) => `${name}(${JSON.stringify(input)})`,
    execute: executor ?? (async () => ({ ok: true })),
  }
}

/** A runner that replays a scripted list of turns and records what it was given. */
function scriptedRunner(turns: Array<Partial<ModelTurn>>) {
  const calls: { tools: ToolDefinition[][]; toolResults: ToolResult[][] } = { tools: [], toolResults: [] }
  let i = 0
  const runner: ModelRunner = {
    model: 'scripted',
    start: (input: string) => [{ role: 'user', content: input }],
    appendUserMessage: (transcript, content) => { (transcript as unknown[]).push({ role: 'user', content }) },
    appendToolResults: (transcript, results) => {
      calls.toolResults.push(results)
      ;(transcript as unknown[]).push({ role: 'tool_results', results })
    },
    next: async (_transcript, _system, tools) => {
      calls.tools.push(tools)
      const turn = turns[Math.min(i, turns.length - 1)]
      i += 1
      return {
        text: turn.text ?? '',
        toolCalls: turn.toolCalls ?? [],
        usage: turn.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: turn.stopReason ?? 'end_turn',
      }
    },
  }
  return { runner, calls }
}

function collectEvents() {
  const events: CopilotStreamEvent[] = []
  return { events, emit: (event: CopilotStreamEvent) => events.push(event) }
}

test('pure Q&A: end_turn with no tool calls ends the loop with null terminalCall', async () => {
  const { runner } = scriptedRunner([{ text: 'All good.', stopReason: 'end_turn' }])
  const { events, emit } = collectEvents()
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [readTool('get_run')], terminalTool: TERMINAL, emit,
  })
  assert.equal(result.text, 'All good.')
  assert.equal(result.terminalCall, null)
  assert.equal(result.hops, 0)
  assert.deepEqual(events.filter((event) => event.type === 'tool'), [])
})

test('terminal tool call ends the loop and returns its input', async () => {
  const { runner } = scriptedRunner([
    { toolCalls: [{ id: 't1', name: 'get_run', input: { runId: 'r1' } }], stopReason: 'tool_use' },
    { text: 'Proposing.', toolCalls: [{ id: 't2', name: 'propose_config_change', input: { summary: 'x' } }], stopReason: 'tool_use' },
  ])
  const { events, emit } = collectEvents()
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [readTool('get_run')], terminalTool: TERMINAL, emit,
  })
  assert.deepEqual(result.terminalCall, { summary: 'x' })
  assert.equal(result.hops, 1)
  assert.deepEqual(events.filter((event) => event.type === 'tool').map((event) => (event as { name: string }).name), ['get_run'])
})

test('hop budget: after maxReadCalls the model only sees the terminal tool', async () => {
  const read = { toolCalls: [{ id: 'x', name: 'get_run', input: {} }], stopReason: 'tool_use' as const }
  const { runner, calls } = scriptedRunner([read, read, read, { text: 'Done.', stopReason: 'end_turn' as const }])
  const { emit } = collectEvents()
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [readTool('get_run')], terminalTool: TERMINAL, maxReadCalls: 2, emit,
  })
  assert.equal(result.hops, 2)
  // Call 1 and 2 offer read+terminal; after budget exhausts, only terminal.
  assert.equal(calls.tools[0].length, 2)
  assert.equal(calls.tools[1].length, 2)
  assert.deepEqual(calls.tools[2].map((tool) => tool.name), ['propose_config_change'])
})

test('executor failure becomes an {error} tool result and the loop continues', async () => {
  const { runner, calls } = scriptedRunner([
    { toolCalls: [{ id: 't1', name: 'get_run', input: {} }], stopReason: 'tool_use' },
    { text: 'Recovered.', stopReason: 'end_turn' },
  ])
  const { emit } = collectEvents()
  const failing = readTool('get_run', async () => { throw new Error('db exploded') })
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [failing], terminalTool: TERMINAL, emit,
  })
  assert.equal(result.text, 'Recovered.')
  assert.equal(calls.toolResults[0][0].isError, true)
  assert.match(String(calls.toolResults[0][0].content), /db exploded/)
})

test('unknown (hallucinated) tool names get error results, do not count as hops', async () => {
  const { runner, calls } = scriptedRunner([
    { toolCalls: [{ id: 't1', name: 'made_up_tool', input: {} }], stopReason: 'tool_use' },
    { text: 'Ok.', stopReason: 'end_turn' },
  ])
  const { emit } = collectEvents()
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [readTool('get_run')], terminalTool: TERMINAL, emit,
  })
  assert.equal(result.hops, 0)
  assert.equal(calls.toolResults[0][0].isError, true)
})

test('usage sums across hops', async () => {
  const { runner } = scriptedRunner([
    { toolCalls: [{ id: 't1', name: 'get_run', input: {} }], stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 10 } },
    { text: 'Done.', stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 20 } },
  ])
  const { emit } = collectEvents()
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [readTool('get_run')], terminalTool: TERMINAL, emit,
  })
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 30 })
})

test('prose from every turn is concatenated into result.text', async () => {
  const { runner } = scriptedRunner([
    { text: 'Looking at the run.', toolCalls: [{ id: 't1', name: 'get_run', input: {} }], stopReason: 'tool_use' },
    { text: 'The run failed on auth.', stopReason: 'end_turn' },
  ])
  const { emit } = collectEvents()
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [readTool('get_run')], terminalTool: TERMINAL, emit,
  })
  assert.equal(result.text, 'Looking at the run.\n\nThe run failed on auth.')
})
