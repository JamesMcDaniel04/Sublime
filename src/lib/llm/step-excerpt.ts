import { redactDeep } from '@/lib/export/redact'

/**
 * A persisted step row, excerpted for a model's eyes.
 *
 * Copilot read tools (get_run, get_step_output, get_flow_run) return rows the
 * execution path stores IN FULL — the engine needs them intact, since agent
 * replay hashes the input and re-uses the output. Two different redactions
 * therefore have to meet on the way out, and neither subsumes the other:
 *
 *   redactSecrets (in the copilot loop) matches token SHAPES — sk-…, xoxb-…,
 *   JWTs — wherever they appear, including in free prose.
 *   redactDeep (here) matches credential KEY NAMES — access_token, password,
 *   client_secret — whose values are opaque strings no pattern would catch.
 *
 * Redact before clipping so a credential can't survive by straddling the cut.
 */
export function redactedExcerpt(value: unknown, max: number): string {
  if (value == null) return ''
  const redacted = redactDeep(value)
  const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted)
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text
}
