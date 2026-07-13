const SLACK_API = 'https://slack.com/api'

export type SlackChannel = {
  id: string
  name: string
  isPrivate: boolean
  isMember: boolean
}

export async function listSlackChannels(botToken: string, fetchImpl: typeof fetch = fetch): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = []
  let cursor = ''
  do {
    const url = new URL(`${SLACK_API}/conversations.list`)
    url.searchParams.set('types', 'public_channel,private_channel')
    url.searchParams.set('exclude_archived', 'true')
    url.searchParams.set('limit', '200')
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(15_000),
    })
    const body = await response.json() as Record<string, unknown>
    if (body.ok !== true) throw new Error(`Slack conversations.list failed: ${body.error ?? 'unknown'}`)
    for (const raw of Array.isArray(body.channels) ? body.channels : []) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      if (typeof row.id !== 'string' || typeof row.name !== 'string') continue
      channels.push({ id: row.id, name: row.name, isPrivate: row.is_private === true, isMember: row.is_member === true })
    }
    const metadata = body.response_metadata as Record<string, unknown> | undefined
    cursor = typeof metadata?.next_cursor === 'string' ? metadata.next_cursor.trim() : ''
  } while (cursor && channels.length < 1_000)
  return channels.sort((a, b) => a.name.localeCompare(b.name))
}
