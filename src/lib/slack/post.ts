/** Outbound Slack posting for the reply-to-origin hook. Slack returns HTTP
 * 200 even on failure — body.ok is authoritative (same as SlackToolClient). */
const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage'

export async function postSlackMessage(args: {
  botToken: string
  channel: string
  threadTs?: string
  text: string
  fetchImpl?: typeof fetch
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? fetch
  const response = await fetchImpl(SLACK_POST_MESSAGE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      channel: args.channel,
      text: args.text,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await response.json()) as Record<string, unknown>
  if (body.ok !== true) throw new Error(`Slack API error: ${body.error ?? 'unknown'}`)
}

/** SSRF guard: `response_url` is copied verbatim from a slash-command
 * request body, gated only by an HMAC that Den never verifies against Slack
 * (see postSlackResponseUrl doc). A forged payload could point it at an
 * internal/metadata host (e.g. `http://169.254.169.254/...`). Real Slack
 * response_urls are always `https://hooks.slack.com/...` — enforce that
 * exact host, not a general "public URL" check. */
function assertSlackResponseUrl(responseUrl: string): void {
  const parsed = new URL(responseUrl)
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'hooks.slack.com') {
    throw new Error(`Refusing to post to non-Slack response_url host: ${parsed.hostname || responseUrl}`)
  }
}

/** Slash-command reply via response_url (valid ~30 min; caller falls back to
 * chat.postMessage on failure). */
export async function postSlackResponseUrl(args: { responseUrl: string; text: string; fetchImpl?: typeof fetch }): Promise<void> {
  assertSlackResponseUrl(args.responseUrl)
  const fetchImpl = args.fetchImpl ?? fetch
  const response = await fetchImpl(args.responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ response_type: 'in_channel', text: args.text }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Slack response_url error: HTTP ${response.status}`)
}
