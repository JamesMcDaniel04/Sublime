/**
 * Turn a persisted run transcript into a replayable eval fixture.
 *
 * `AgentExecution.transcript` is provider-native message JSON. This walks it —
 * Anthropic (content blocks) or OpenAI (tool_calls + tool messages) shape — and
 * lifts it into the provider-neutral ScriptedTurn form the harness replays. A
 * real run (a bug you just fixed, a golden success path) becomes a deterministic
 * regression fixture: `fixtureFromTranscript(...)` then commit it under fixtures/.
 */
import type { EvalFixture, ScriptedToolCall, ScriptedTurn, TrajectoryExpectation } from './types'

type AnyMsg = { role?: string; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown }

/** Index tool results by their call id, across both provider shapes. */
function collectToolResults(messages: AnyMsg[]): Map<string, { content: string; isError: boolean }> {
  const byId = new Map<string, { content: string; isError: boolean }>()
  for (const msg of messages) {
    // Anthropic: a user message whose content is an array of tool_result blocks.
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          byId.set(block.tool_use_id, { content: stringifyContent(block.content), isError: Boolean(block.is_error) })
        }
      }
    }
    // OpenAI: a role:'tool' message with a tool_call_id.
    if (msg.role === 'tool' && typeof msg.tool_call_id === 'string') {
      byId.set(msg.tool_call_id, { content: stringifyContent(msg.content), isError: false })
    }
  }
  return byId
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : typeof (c as { text?: unknown })?.text === 'string' ? (c as { text: string }).text : JSON.stringify(c)))
      .join('\n')
  }
  return JSON.stringify(content ?? null)
}

/** Extract text + tool calls from one assistant message (either shape). */
function assistantTurn(msg: AnyMsg, results: Map<string, { content: string; isError: boolean }>): ScriptedTurn {
  const toolCalls: ScriptedToolCall[] = []
  let text = ''

  if (Array.isArray(msg.content)) {
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block?.type === 'text' && typeof block.text === 'string') text += (text ? '\n' : '') + block.text
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        const res = typeof block.id === 'string' ? results.get(block.id) : undefined
        toolCalls.push({
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
          result: res ? safeParse(res.content) : undefined,
          isError: res?.isError,
        })
      }
    }
  } else if (typeof msg.content === 'string') {
    text = msg.content
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls as Array<Record<string, any>>) {
      const fn = call?.function ?? {}
      const id = typeof call?.id === 'string' ? call.id : undefined
      const res = id ? results.get(id) : undefined
      toolCalls.push({
        name: String(fn.name ?? ''),
        input: safeParse(fn.arguments ?? '{}') as Record<string, unknown>,
        result: res ? safeParse(res.content) : undefined,
        isError: res?.isError,
      })
    }
  }

  return { text, toolCalls }
}

function safeParse(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function fixtureFromTranscript(opts: {
  name: string
  system: string
  transcript: unknown[]
  /** Falls back to the first user message's text if omitted. */
  input?: string
  expect?: TrajectoryExpectation
  rubric?: string
}): EvalFixture {
  const messages = (opts.transcript as AnyMsg[]).filter((m) => m && typeof m === 'object')
  const results = collectToolResults(messages)

  const firstUser = messages.find((m) => m.role === 'user')
  const input = opts.input ?? (typeof firstUser?.content === 'string' ? firstUser.content : stringifyContent(firstUser?.content))

  const script = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => assistantTurn(m, results))

  return { name: opts.name, system: opts.system, input, script, expect: opts.expect, rubric: opts.rubric }
}
