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

export const TOOL_RESULT_MAX_CHARS = Number(process.env.AGENT_TOOL_RESULT_MAX_CHARS) || 50_000

export function serializeToolResult(value: unknown, maxChars = TOOL_RESULT_MAX_CHARS): string {
  const raw = JSON.stringify(value ?? null)
  if (maxChars <= 0 || raw.length <= maxChars) return raw
  return JSON.stringify({
    truncated: true,
    totalChars: raw.length,
    note: 'Tool result truncated to fit the context window. Ask for a narrower slice (filters, pagination, fewer fields) if you need more.',
    content: raw.slice(0, maxChars),
  })
}
