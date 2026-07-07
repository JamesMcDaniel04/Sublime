/**
 * Provider-neutral transcript IR.
 *
 * The agent transcript is persisted (and replayed on resume) in THIS canonical
 * shape rather than a provider's native message JSON. That buys three things:
 *
 *   1. In-loop provider fallback — a turn that fails on Anthropic can be retried
 *      on OpenAI (and vice-versa) using the exact same transcript.
 *   2. Cross-provider durability — a run started on one provider can be resumed
 *      on another after a routing change or an outage.
 *   3. A stable persisted format independent of any SDK's message schema.
 *
 * Lossless same-provider replay: each assistant message keeps the ORIGINAL
 * native content on `raw`, so Anthropic thinking blocks (signature-verified, and
 * rejected by the API if modified) survive a pause/resume round-trip untouched.
 * When translating to a DIFFERENT provider, `raw` is ignored and the message is
 * rebuilt from the neutral fields — which correctly DROPS thinking blocks, the
 * same rule Anthropic itself applies when a prompt crosses models.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type OpenAI from 'openai'

export type ProviderKind = 'anthropic' | 'openai'

export type IRToolCall = { id: string; name: string; input: Record<string, unknown> }
export type IRToolResult = { toolCallId: string; content: string; isError?: boolean }

export type IRUserMessage = { role: 'user'; content: string }
export type IRAssistantMessage = {
  role: 'assistant'
  text: string
  toolCalls: IRToolCall[]
  /** Original native content, for lossless replay on the SAME provider. */
  raw?: { provider: ProviderKind; content: unknown }
}
export type IRToolMessage = { role: 'tool'; results: IRToolResult[] }
export type IRMessage = IRUserMessage | IRAssistantMessage | IRToolMessage

// ── Builders ─────────────────────────────────────────────────────────────────
export const irUser = (content: string): IRUserMessage => ({ role: 'user', content })
export const irToolResults = (results: IRToolResult[]): IRToolMessage => ({ role: 'tool', results })

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : typeof (c as { text?: unknown })?.text === 'string' ? (c as { text: string }).text : JSON.stringify(c)))
      .join('\n')
  }
  return JSON.stringify(content ?? null)
}

function safeJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// ── Anthropic translation ────────────────────────────────────────────────────
export function toAnthropicMessages(ir: IRMessage[]): Anthropic.MessageParam[] {
  return ir.map((m): Anthropic.MessageParam => {
    if (m.role === 'user') return { role: 'user', content: m.content }
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.toolCallId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      }
    }
    // assistant — verbatim native content for same-provider lossless replay.
    if (m.raw?.provider === 'anthropic') {
      return { role: 'assistant', content: m.raw.content as Anthropic.ContentBlockParam[] }
    }
    const blocks: Anthropic.ContentBlockParam[] = []
    if (m.text) blocks.push({ type: 'text', text: m.text })
    for (const tc of m.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
    // Anthropic requires non-empty assistant content.
    return { role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] }
  })
}

export function irFromAnthropic(message: Anthropic.Message): IRAssistantMessage {
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  const toolCalls = message.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: (b.input || {}) as Record<string, unknown> }))
  return { role: 'assistant', text, toolCalls, raw: { provider: 'anthropic', content: message.content } }
}

// ── OpenAI translation ───────────────────────────────────────────────────────
export function toOpenAIMessages(ir: IRMessage[], system: string): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: system }]
  for (const m of ir) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    } else if (m.role === 'tool') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content })
    } else if (m.raw?.provider === 'openai') {
      out.push(m.raw.content as OpenAI.ChatCompletionMessageParam)
    } else {
      const msg: OpenAI.ChatCompletionAssistantMessageParam = { role: 'assistant', content: m.text || null }
      if (m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }))
      }
      out.push(msg)
    }
  }
  return out
}

export function irFromOpenAI(message: OpenAI.ChatCompletionMessage): IRAssistantMessage {
  const toolCalls = (message.tool_calls || [])
    .filter((c): c is OpenAI.ChatCompletionMessageToolCall & { type: 'function' } => c.type === 'function')
    .map((c) => ({ id: c.id, name: c.function.name, input: safeJson(c.function.arguments) }))
  return { role: 'assistant', text: (message.content || '').trim(), toolCalls, raw: { provider: 'openai', content: message } }
}

// ── Backward-compatible coercion ─────────────────────────────────────────────
/**
 * Normalize a persisted transcript to IR. New runs are IR from the start; this
 * lets a run persisted in a NATIVE shape (Anthropic content blocks, or OpenAI
 * tool_calls + role:'tool' messages) — e.g. an in-flight run across the deploy
 * that introduced IR — still resume. Idempotent on already-IR input.
 */
export function coerceToIR(transcript: unknown[]): IRMessage[] {
  const out: IRMessage[] = []
  for (const raw of transcript) {
    const m = raw as Record<string, unknown>
    if (!m || typeof m !== 'object') continue

    // Already IR.
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && typeof m.text === 'string') {
      out.push(m as unknown as IRAssistantMessage)
      continue
    }
    if (m.role === 'tool' && Array.isArray(m.results)) {
      out.push(m as unknown as IRToolMessage)
      continue
    }
    if (m.role === 'user' && typeof m.content === 'string') {
      out.push({ role: 'user', content: m.content })
      continue
    }

    // Native Anthropic tool results (a user message of tool_result blocks).
    if (m.role === 'user' && Array.isArray(m.content)) {
      const results = (m.content as Array<Record<string, unknown>>)
        .filter((b) => b?.type === 'tool_result')
        .map((b) => ({ toolCallId: String(b.tool_use_id), content: stringifyContent(b.content), isError: Boolean(b.is_error) }))
      out.push({ role: 'tool', results })
      continue
    }

    // Native OpenAI tool message — merge consecutive ones into one IR turn.
    if (m.role === 'tool' && typeof m.tool_call_id === 'string') {
      const res = { toolCallId: m.tool_call_id, content: stringifyContent(m.content), isError: false }
      const last = out[out.length - 1]
      if (last && last.role === 'tool') last.results.push(res)
      else out.push({ role: 'tool', results: [res] })
      continue
    }

    // Native assistant.
    if (m.role === 'assistant') {
      if (Array.isArray(m.content)) {
        // Anthropic content blocks.
        const content = m.content as Array<Record<string, unknown>>
        const text = content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n').trim()
        const toolCalls = content
          .filter((b) => b?.type === 'tool_use')
          .map((b) => ({ id: String(b.id), name: String(b.name), input: (b.input ?? {}) as Record<string, unknown> }))
        out.push({ role: 'assistant', text, toolCalls, raw: { provider: 'anthropic', content } })
      } else {
        // OpenAI assistant message.
        const toolCalls = (Array.isArray(m.tool_calls) ? (m.tool_calls as Array<Record<string, any>>) : [])
          .filter((c) => c?.type === 'function' && c.function)
          .map((c) => ({ id: String(c.id), name: String(c.function.name), input: safeJson(c.function.arguments) }))
        out.push({ role: 'assistant', text: String(m.content ?? '').trim(), toolCalls, raw: { provider: 'openai', content: m } })
      }
      continue
    }
  }
  return out
}
