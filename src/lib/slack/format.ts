/** Flow output → Slack mrkdwn (pure). Strings pass through; objects/arrays
 * become fenced JSON; 4k-char truncation with a run-link suffix. */
export const SLACK_REPLY_MAX_CHARS = 4000

export function formatSlackReply(output: unknown, opts: { runUrl?: string } = {}): string {
  let text: string
  if (output === null || output === undefined || output === '') text = '_(no output)_'
  else if (typeof output === 'string') text = output
  else if (typeof output === 'object') {
    try {
      text = '```json\n' + JSON.stringify(output, null, 2) + '\n```'
    } catch {
      text = String(output)
    }
  } else text = String(output)

  if (text.length <= SLACK_REPLY_MAX_CHARS) return text
  const suffix = opts.runUrl ? `\n_…truncated — full output: ${opts.runUrl}_` : '\n_…truncated_'
  return text.slice(0, SLACK_REPLY_MAX_CHARS - suffix.length) + suffix
}
