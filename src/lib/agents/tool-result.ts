/**
 * Bounded serialization for tool results entering the LLM transcript.
 *
 * Tool output is persisted in full on the workflow step row; the transcript
 * copy is what the model re-reads every turn, so one oversized result (a CRM
 * list, a full meeting transcript) must not blow the context window in a
 * single turn — that 400s the next model call and terminally fails the run.
 * Oversized results become a valid-JSON wrapper that tells the model it is
 * looking at a truncated view.
 */

import { redactSecrets, wrapUntrusted, UNTRUSTED_TOOL_OUTPUT } from '@/lib/llm/guardrails'

export const TOOL_RESULT_MAX_CHARS = Number(process.env.AGENT_TOOL_RESULT_MAX_CHARS) || 50_000

export function serializeToolResult(value: unknown, maxChars = TOOL_RESULT_MAX_CHARS): string {
  // Redact credential-shaped strings before the result enters the transcript
  // (and therefore the provider). The full result stays on the step row.
  const raw = redactSecrets(JSON.stringify(value ?? null))

  const body =
    maxChars <= 0 || raw.length <= maxChars
      ? raw
      : JSON.stringify({
          truncated: true,
          totalChars: raw.length,
          note: 'Tool result truncated to fit the context window. Ask for a narrower slice (filters, pagination, fewer fields) if you need more.',
          content: raw.slice(0, maxChars),
        })

  // Fence AFTER truncating, never before: the budget applies to the payload, so
  // the closing marker can never be the thing that gets cut. A half-open fence
  // would read as ordinary prompt text and quietly undo the whole control.
  //
  // Redaction alone protected the credentials in a tool result; it did nothing
  // about instructions inside one. This is the other half.
  return wrapUntrusted(body, UNTRUSTED_TOOL_OUTPUT)
}
