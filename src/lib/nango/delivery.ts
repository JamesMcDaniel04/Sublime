/**
 * Nango outbound delivery adapters.
 *
 * Nango is the delivery arm: agents post to Slack, send Gmail, and write
 * Salesforce records through connected accounts. Delivery prefers the acting
 * user's OWN connection (so a message arrives as the rep) and falls back to an
 * org-level connection.
 *
 * Each adapter goes through Nango's proxy so credentials never touch our
 * process. The proxy is injectable for tests.
 */

import { prisma } from '@/lib/prisma'
import { getNangoClient, nangoConfigured } from './client'

export interface DeliveryConnection {
  connectionId: string
  providerConfigKey: string
  scope: 'user' | 'org'
  /** Mirror-row provider marker; 'google-native' routes through googleProxy. */
  provider?: string | null
  /** Org scope for native-proxy token lookups (tenant-guarded store). */
  organizationId?: string
}

/** Provider config keys we treat as delivery targets, by capability. */
export const DELIVERY_PROVIDERS = {
  slack: ['slack'],
  gmail: ['google-mail', 'gmail'],
  // Native-Google-only capabilities: the provider config key is the native
  // OAuth service name (the mirror NangoConnection row's providerConfigKey).
  sheets: ['google-sheets'],
  drive: ['google-drive'],
  calendar: ['google-calendar'],
  analytics: ['google-analytics'],
  salesforce: ['salesforce', 'salesforce-sandbox'],
  asana: ['asana'],
  clickup: ['clickup'],
  confluence: ['confluence'],
  github: ['github-app', 'github'],
  intercom: ['intercom', 'intercom-fhmb'],
  monday: ['monday'],
  perplexity: ['perplexity'],
} as const

export type DeliveryCapability = keyof typeof DELIVERY_PROVIDERS

/**
 * providerConfigKey (e.g. "google-mail") → the scan-plane delivery
 * capability it maps to, if any. Shared by the status route's scan trigger,
 * the explicit disconnect route, and the integrations grid's per-connection
 * "Learning" toggle — the same mapping must be used everywhere a Nango
 * connection's capability needs deriving.
 */
export function capabilityForProviderConfigKey(providerConfigKey: string): DeliveryCapability | undefined {
  const entry = (Object.entries(DELIVERY_PROVIDERS) as [DeliveryCapability, readonly string[]][]).find(([, keys]) =>
    keys.includes(providerConfigKey),
  )
  return entry?.[0]
}

/**
 * Pure reconciliation for Nango purge-on-disconnect (Task 5, Fix B2):
 * learnings are keyed by *capability*, not by raw Nango connection id, and
 * more than one connection — even under different providerConfigKeys (e.g.
 * "google-mail" and "gmail" both map to `gmail`) — can share one. So a
 * capability must be purged only when NO remaining connected Nango
 * connection still maps to it.
 *
 * `affected` is the capability (or capabilities) touched by the connection(s)
 * just disconnected; `stillConnected` is every capability at least one
 * currently-connected Nango connection still maps to. Returns the subset of
 * `affected` that is no longer in `stillConnected` — i.e. safe to purge.
 */
export function capabilitiesToPurgeOnDisconnect<T extends string>(affected: T[], stillConnected: T[]): T[] {
  const remaining = new Set(stillConnected)
  return [...new Set(affected)].filter((capability) => !remaining.has(capability))
}

/**
 * Pure selection rule for delivery credentials: the acting user's own
 * connection, else an org-shared one (userId null). Another user's personal
 * connection is NEVER eligible — using it would send outbound writes under
 * someone else's identity. No match → null (delivery fails closed).
 */
export function chooseDeliveryConnection<T extends { userId?: string | null }>(
  connections: T[],
  userId?: string | null,
): T | null {
  const own = userId ? connections.find((connection) => connection.userId === userId) : undefined
  return own ?? connections.find((connection) => !connection.userId) ?? null
}

/**
 * Resolve the connection to use for a capability: the acting user's own
 * connection first, then an org-shared connection (no userId). Another user's
 * personal connection is NEVER used — falling back to it would send Gmail/
 * Slack/Salesforce writes under someone else's identity and leak their
 * credential to whatever the agent composes. No own/shared connection means
 * the delivery fails closed (null). Matches provider config keys for the
 * capability.
 */
export async function resolveDeliveryConnection(
  organizationId: string,
  capability: DeliveryCapability,
  userId?: string | null,
): Promise<DeliveryConnection | null> {
  const keys = DELIVERY_PROVIDERS[capability] as readonly string[]
  const connections = await prisma.nangoConnection.findMany({
    where: { organizationId, providerConfigKey: { in: [...keys] }, status: 'connected' },
  })
  if (connections.length === 0) return null

  const chosen = chooseDeliveryConnection(connections, userId)
  if (!chosen) return null
  return {
    connectionId: chosen.connectionId,
    providerConfigKey: chosen.providerConfigKey,
    scope: chosen.userId === userId && userId ? 'user' : 'org',
    provider: chosen.provider ?? null,
    organizationId,
  }
}

// ── Proxy seam ───────────────────────────────────────────────────────────────

export interface NangoProxyArgs {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  endpoint: string
  connectionId: string
  providerConfigKey: string
  data?: unknown
  params?: Record<string, string | number>
  /** Media type for raw string `data` (native Google uploads); ignored by Nango. */
  contentType?: string
}

export type NangoProxy = (args: NangoProxyArgs) => Promise<{ data: unknown }>

/**
 * Race a promise against a deadline. Nango's ProxyConfiguration exposes no
 * timeout and its axios layer defaults to none, so a hung upstream (Slack/Gmail/
 * Salesforce not responding) would block a delivery — and therefore an agent
 * run — indefinitely. Racing rejects the caller at the deadline; the dangling
 * request is left to settle and is ignored.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

/** Per-request Nango proxy ceiling, read at call time; env-tunable, default 20s. */
function proxyTimeoutMs(): number {
  const parsed = Math.floor(Number(process.env.NANGO_PROXY_TIMEOUT_MS))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000
}

function defaultProxy(): NangoProxy {
  const nango = getNangoClient()
  return (args) =>
    withTimeout(
      nango.proxy(args as never) as Promise<{ data: unknown }>,
      proxyTimeoutMs(),
      `Nango proxy ${args.method} ${args.endpoint}`,
    )
}

// ── Adapters ─────────────────────────────────────────────────────────────────

export async function slackPostMessage(
  connection: DeliveryConnection,
  args: { channel: string; text: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: '/chat.postMessage',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { channel: args.channel, text: args.text },
  })
  return response.data
}

export async function gmailSendEmail(
  connection: DeliveryConnection,
  args: { to: string; subject: string; body: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  // RFC 2822 message, base64url-encoded, per the Gmail send API.
  const raw = Buffer.from(
    [`To: ${args.to}`, `Subject: ${args.subject}`, 'Content-Type: text/plain; charset=UTF-8', '', args.body].join('\r\n'),
  ).toString('base64url')
  const response = await proxy({
    method: 'POST',
    endpoint: '/gmail/v1/users/me/messages/send',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { raw },
  })
  return response.data
}

export async function salesforceCreateRecord(
  connection: DeliveryConnection,
  args: { sobject: string; fields: Record<string, unknown> },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: `/services/data/v60.0/sobjects/${args.sobject}`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: args.fields,
  })
  return response.data
}

export async function slackUpdateMessage(
  connection: DeliveryConnection,
  args: { channel: string; ts: string; text: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: '/chat.update',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { channel: args.channel, ts: args.ts, text: args.text },
  })
  return response.data
}

export async function slackGetChannelHistory(
  connection: DeliveryConnection,
  args: { channel: string; limit?: number },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'GET',
    endpoint: '/conversations.history',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: { channel: args.channel, ...(args.limit ? { limit: String(args.limit) } : {}) },
  })
  return response.data
}

export async function slackAddReaction(
  connection: DeliveryConnection,
  args: { channel: string; timestamp: string; name: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: '/reactions.add',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { channel: args.channel, timestamp: args.timestamp, name: args.name },
  })
  return response.data
}

export async function gmailGetMessage(
  connection: DeliveryConnection,
  args: { id: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'GET',
    endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(args.id)}`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
  })
  return response.data
}

export async function gmailListMessages(
  connection: DeliveryConnection,
  args: { query?: string; maxResults?: number },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'GET',
    endpoint: '/gmail/v1/users/me/messages',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: {
      ...(args.query ? { q: args.query } : {}),
      ...(args.maxResults ? { maxResults: String(args.maxResults) } : {}),
    },
  })
  return response.data
}

export async function gmailTrashMessage(
  connection: DeliveryConnection,
  args: { id: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(args.id)}/trash`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
  })
  return response.data
}

export async function sheetsClearValues(
  connection: DeliveryConnection,
  args: { spreadsheetId: string; range: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: `/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}:clear`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
  })
  return response.data
}

export async function salesforceUpdateRecord(
  connection: DeliveryConnection,
  args: { sobject: string; id: string; fields: Record<string, unknown> },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'PATCH',
    endpoint: `/services/data/v60.0/sobjects/${args.sobject}/${encodeURIComponent(args.id)}`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: args.fields,
  })
  return response.data
}

export async function salesforceGetRecord(
  connection: DeliveryConnection,
  args: { sobject: string; id: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'GET',
    endpoint: `/services/data/v60.0/sobjects/${args.sobject}/${encodeURIComponent(args.id)}`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
  })
  return response.data
}

export async function salesforceQuery(
  connection: DeliveryConnection,
  args: { soql: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'GET',
    endpoint: '/services/data/v60.0/query',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: { q: args.soql },
  })
  return response.data
}

export async function asanaCreateTask(
  connection: DeliveryConnection,
  args: { projectGid: string; name: string; notes?: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: '/api/1.0/tasks',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { data: { name: args.name, projects: [args.projectGid], ...(args.notes ? { notes: args.notes } : {}) } },
  })
  return response.data
}

export async function clickupCreateTask(
  connection: DeliveryConnection,
  args: { listId: string; name: string; description?: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: `/api/v2/list/${encodeURIComponent(args.listId)}/task`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { name: args.name, ...(args.description ? { description: args.description } : {}) },
  })
  return response.data
}

export async function confluenceCreatePage(
  connection: DeliveryConnection,
  args: { spaceId: string; title: string; body: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: '/wiki/api/v2/pages',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: {
      spaceId: args.spaceId,
      status: 'current',
      title: args.title,
      body: { representation: 'storage', value: args.body },
    },
  })
  return response.data
}

export async function githubCreateIssue(
  connection: DeliveryConnection,
  args: { owner: string; repo: string; title: string; body?: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { title: args.title, ...(args.body ? { body: args.body } : {}) },
  })
  return response.data
}

export async function intercomSearchContacts(
  connection: DeliveryConnection,
  args: { email: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: '/contacts/search',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { query: { field: 'email', operator: '=', value: args.email } },
  })
  return response.data
}

export async function mondayCreateItem(
  connection: DeliveryConnection,
  args: { boardId: string; itemName: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  // GraphQL with variables — never interpolate user input into the query string.
  const response = await proxy({
    method: 'POST',
    endpoint: '/v2',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: {
      query: 'mutation ($boardId: ID!, $itemName: String!) { create_item (board_id: $boardId, item_name: $itemName) { id name } }',
      variables: { boardId: args.boardId, itemName: args.itemName },
    },
  })
  return response.data
}

export async function perplexitySearch(
  connection: DeliveryConnection,
  args: { query: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: '/chat/completions',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { model: 'sonar', messages: [{ role: 'user', content: args.query }] },
  })
  return response.data
}

// ── Google Sheets / Drive / Calendar (native-Google-only capabilities) ───────

export async function sheetsGetValues(
  connection: DeliveryConnection,
  args: { spreadsheetId: string; range: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'GET',
    endpoint: `/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
  })
  return response.data
}

export async function sheetsUpdateValues(
  connection: DeliveryConnection,
  args: { spreadsheetId: string; range: string; values: unknown[][] },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'PUT',
    endpoint: `/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: { valueInputOption: 'USER_ENTERED' },
    data: { values: args.values },
  })
  return response.data
}

export async function sheetsAppendRows(
  connection: DeliveryConnection,
  args: { spreadsheetId: string; range: string; values: unknown[][] },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: `/v4/spreadsheets/${encodeURIComponent(args.spreadsheetId)}/values/${encodeURIComponent(args.range)}:append`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
    data: { values: args.values },
  })
  return response.data
}

export async function calendarListEvents(
  connection: DeliveryConnection,
  args: { calendarId?: string; timeMin?: string; timeMax?: string; query?: string; maxResults?: number },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'GET',
    endpoint: `/calendar/v3/calendars/${encodeURIComponent(args.calendarId || 'primary')}/events`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: {
      // Expand recurring events into instances, ordered by start — the shape
      // agents expect when answering "what's on the calendar".
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: Math.max(1, Math.min(250, Number(args.maxResults ?? 50))),
      ...(args.timeMin ? { timeMin: args.timeMin } : {}),
      ...(args.timeMax ? { timeMax: args.timeMax } : {}),
      ...(args.query ? { q: args.query } : {}),
    },
  })
  return response.data
}

/** All-day when dates are YYYY-MM-DD; timed otherwise (RFC3339 datetimes). */
function calendarEventTime(value: string): { date: string } | { dateTime: string } {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value }
}

export async function calendarCreateEvent(
  connection: DeliveryConnection,
  args: { calendarId?: string; summary: string; description?: string; location?: string; start: string; end: string; attendees?: string[] },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: `/calendar/v3/calendars/${encodeURIComponent(args.calendarId || 'primary')}/events`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: {
      summary: args.summary,
      ...(args.description ? { description: args.description } : {}),
      ...(args.location ? { location: args.location } : {}),
      start: calendarEventTime(args.start),
      end: calendarEventTime(args.end),
      ...(args.attendees?.length ? { attendees: args.attendees.map((email) => ({ email })) } : {}),
    },
  })
  return response.data
}

export async function driveListFiles(
  connection: DeliveryConnection,
  args: { query?: string; maxResults?: number },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'GET',
    endpoint: '/drive/v3/files',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: {
      pageSize: Math.max(1, Math.min(100, Number(args.maxResults ?? 25))),
      fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
      ...(args.query ? { q: args.query } : {}),
    },
  })
  return response.data
}

export async function driveDownloadFile(
  connection: DeliveryConnection,
  args: { fileId: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'GET',
    endpoint: `/drive/v3/files/${encodeURIComponent(args.fileId)}`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: { alt: 'media' },
  })
  return response.data
}

export async function driveUploadFile(
  connection: DeliveryConnection,
  args: { name: string; content: string; mimeType?: string; folderId?: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  // Two-step create: metadata first (name/parents can't ride a media upload),
  // then the raw content as a media PATCH. The drive.file scope covers both.
  const mimeType = args.mimeType || 'text/plain'
  const created = await proxy({
    method: 'POST',
    endpoint: '/drive/v3/files',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { name: args.name, mimeType, ...(args.folderId ? { parents: [args.folderId] } : {}) },
  })
  const fileId = (created.data as { id?: string })?.id
  if (!fileId) throw new Error('Drive file create returned no id.')
  await proxy({
    method: 'PATCH',
    endpoint: `/upload/drive/v3/files/${encodeURIComponent(fileId)}`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: { uploadType: 'media' },
    data: args.content,
    contentType: mimeType,
  })
  return created.data
}

export async function analyticsListProperties(
  connection: DeliveryConnection,
  args: { maxResults?: number },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  // Account summaries nest each account's property list — one call covers
  // discovery, so the Admin API surface stays at this single endpoint.
  const response = await proxy({
    method: 'GET',
    endpoint: '/v1beta/accountSummaries',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: { pageSize: Math.max(1, Math.min(200, Number(args.maxResults ?? 50))) },
  })
  return response.data
}

export async function analyticsRunReport(
  connection: DeliveryConnection,
  args: { propertyId: string; metrics: string[]; dimensions?: string[]; startDate?: string; endDate?: string; maxResults?: number },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  // GA property ids are numeric; accept "properties/123" too since that is
  // how the Admin API returns them.
  const propertyId = args.propertyId.replace(/^properties\//, '')
  const response = await proxy({
    method: 'POST',
    endpoint: `/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: {
      metrics: args.metrics.map((name) => ({ name })),
      ...(args.dimensions?.length ? { dimensions: args.dimensions.map((name) => ({ name })) } : {}),
      dateRanges: [{ startDate: args.startDate || '28daysAgo', endDate: args.endDate || 'today' }],
      limit: Math.max(1, Math.min(1000, Number(args.maxResults ?? 100))),
    },
  })
  return response.data
}

// ── Tool descriptors for the agent runtime ───────────────────────────────────

export interface DeliveryToolSpec {
  capability: DeliveryCapability
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (connection: DeliveryConnection, args: Record<string, unknown>, proxy?: NangoProxy) => Promise<unknown>
}

export const DELIVERY_TOOLS: DeliveryToolSpec[] = [
  {
    capability: 'slack',
    name: 'slack_post_message',
    description: 'Post a message to a Slack channel or user as the connected account.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id or name (e.g. #revenue) or user id for a DM.' },
        text: { type: 'string', description: 'Message text.' },
      },
      required: ['channel', 'text'],
    },
    run: (connection, args, proxy) =>
      slackPostMessage(connection, { channel: String(args.channel), text: String(args.text) }, proxy),
  },
  {
    capability: 'gmail',
    name: 'gmail_send_email',
    description: 'Send an email from the connected Gmail account.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
    run: (connection, args, proxy) =>
      gmailSendEmail(
        connection,
        { to: String(args.to), subject: String(args.subject), body: String(args.body) },
        proxy,
      ),
  },
  {
    capability: 'sheets',
    name: 'sheets_get_values',
    description: 'Read a cell range from a Google Sheet (A1 notation).',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The spreadsheet id (from its URL).' },
        range: { type: 'string', description: 'A1-notation range, e.g. Sheet1!A1:D50.' },
      },
      required: ['spreadsheet_id', 'range'],
    },
    run: (connection, args, proxy) =>
      sheetsGetValues(connection, { spreadsheetId: String(args.spreadsheet_id), range: String(args.range) }, proxy),
  },
  {
    capability: 'sheets',
    name: 'sheets_update_values',
    description: 'Overwrite a cell range in a Google Sheet with new values.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The spreadsheet id (from its URL).' },
        range: { type: 'string', description: 'A1-notation range to write, e.g. Sheet1!A2:C2.' },
        values: { type: 'array', items: { type: 'array' }, description: 'Rows of cell values.' },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
    run: (connection, args, proxy) =>
      sheetsUpdateValues(
        connection,
        { spreadsheetId: String(args.spreadsheet_id), range: String(args.range), values: (args.values as unknown[][]) ?? [] },
        proxy,
      ),
  },
  {
    capability: 'sheets',
    name: 'sheets_append_rows',
    description: 'Append rows after the last data row of a Google Sheet range.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The spreadsheet id (from its URL).' },
        range: { type: 'string', description: 'A1-notation table range to append to, e.g. Sheet1!A:C.' },
        values: { type: 'array', items: { type: 'array' }, description: 'Rows of cell values to append.' },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
    run: (connection, args, proxy) =>
      sheetsAppendRows(
        connection,
        { spreadsheetId: String(args.spreadsheet_id), range: String(args.range), values: (args.values as unknown[][]) ?? [] },
        proxy,
      ),
  },
  {
    capability: 'calendar',
    name: 'calendar_list_events',
    description: 'List events from the connected Google Calendar (recurring events expanded, ordered by start).',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string', description: 'Calendar id; defaults to the primary calendar.' },
        time_min: { type: 'string', description: 'RFC3339 lower bound, e.g. 2026-07-22T00:00:00Z.' },
        time_max: { type: 'string', description: 'RFC3339 upper bound.' },
        query: { type: 'string', description: 'Free-text search over event fields.' },
        max_results: { type: 'number', description: 'Max events to return (default 50, cap 250).' },
      },
    },
    run: (connection, args, proxy) =>
      calendarListEvents(
        connection,
        {
          ...(args.calendar_id ? { calendarId: String(args.calendar_id) } : {}),
          ...(args.time_min ? { timeMin: String(args.time_min) } : {}),
          ...(args.time_max ? { timeMax: String(args.time_max) } : {}),
          ...(args.query ? { query: String(args.query) } : {}),
          ...(args.max_results !== undefined ? { maxResults: Number(args.max_results) } : {}),
        },
        proxy,
      ),
  },
  {
    capability: 'calendar',
    name: 'calendar_create_event',
    description: 'Create an event on the connected Google Calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string', description: 'Calendar id; defaults to the primary calendar.' },
        summary: { type: 'string', description: 'Event title.' },
        description: { type: 'string', description: 'Optional event description.' },
        location: { type: 'string', description: 'Optional location.' },
        start: { type: 'string', description: 'Start: RFC3339 datetime, or YYYY-MM-DD for an all-day event.' },
        end: { type: 'string', description: 'End: RFC3339 datetime, or YYYY-MM-DD for an all-day event.' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses.' },
      },
      required: ['summary', 'start', 'end'],
    },
    run: (connection, args, proxy) =>
      calendarCreateEvent(
        connection,
        {
          summary: String(args.summary),
          start: String(args.start),
          end: String(args.end),
          ...(args.calendar_id ? { calendarId: String(args.calendar_id) } : {}),
          ...(args.description ? { description: String(args.description) } : {}),
          ...(args.location ? { location: String(args.location) } : {}),
          ...(Array.isArray(args.attendees) ? { attendees: args.attendees.map(String) } : {}),
        },
        proxy,
      ),
  },
  {
    capability: 'drive',
    name: 'drive_list_files',
    description: 'List Google Drive files this workspace can access (files it created or was granted).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Drive query, e.g. name contains 'report' or mimeType='application/pdf'." },
        max_results: { type: 'number', description: 'Max files to return (default 25, cap 100).' },
      },
    },
    run: (connection, args, proxy) =>
      driveListFiles(
        connection,
        {
          ...(args.query ? { query: String(args.query) } : {}),
          ...(args.max_results !== undefined ? { maxResults: Number(args.max_results) } : {}),
        },
        proxy,
      ),
  },
  {
    capability: 'drive',
    name: 'drive_download_file',
    description: 'Download the content of a Google Drive file by id.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'The Drive file id.' },
      },
      required: ['file_id'],
    },
    run: (connection, args, proxy) => driveDownloadFile(connection, { fileId: String(args.file_id) }, proxy),
  },
  {
    capability: 'drive',
    name: 'drive_upload_file',
    description: 'Create a file in Google Drive with the given text content.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name, e.g. notes.txt.' },
        content: { type: 'string', description: 'File content (text).' },
        mime_type: { type: 'string', description: 'MIME type; defaults to text/plain.' },
        folder_id: { type: 'string', description: 'Optional parent folder id.' },
      },
      required: ['name', 'content'],
    },
    run: (connection, args, proxy) =>
      driveUploadFile(
        connection,
        {
          name: String(args.name),
          content: String(args.content),
          ...(args.mime_type ? { mimeType: String(args.mime_type) } : {}),
          ...(args.folder_id ? { folderId: String(args.folder_id) } : {}),
        },
        proxy,
      ),
  },
  {
    capability: 'analytics',
    name: 'analytics_list_properties',
    description: 'List the GA4 accounts and properties visible to the connected Google Analytics account.',
    inputSchema: {
      type: 'object',
      properties: {
        max_results: { type: 'number', description: 'Max account summaries to return (default 50, cap 200).' },
      },
    },
    run: (connection, args, proxy) =>
      analyticsListProperties(
        connection,
        { ...(args.max_results !== undefined ? { maxResults: Number(args.max_results) } : {}) },
        proxy,
      ),
  },
  {
    capability: 'analytics',
    name: 'analytics_run_report',
    description: 'Run a GA4 report: pick metrics (e.g. activeUsers, sessions) and optional dimensions (e.g. date, country) over a date range.',
    inputSchema: {
      type: 'object',
      properties: {
        property_id: { type: 'string', description: 'GA4 property id (numeric, or "properties/123").' },
        metrics: { type: 'array', items: { type: 'string' }, description: 'GA4 metric names, e.g. activeUsers, sessions, screenPageViews.' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Optional GA4 dimension names, e.g. date, country, pagePath.' },
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD or NdaysAgo); defaults to 28daysAgo.' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD or today); defaults to today.' },
        max_results: { type: 'number', description: 'Max rows to return (default 100, cap 1000).' },
      },
      required: ['property_id', 'metrics'],
    },
    run: (connection, args, proxy) =>
      analyticsRunReport(
        connection,
        {
          propertyId: String(args.property_id),
          metrics: ((args.metrics as unknown[]) ?? []).map(String),
          ...(Array.isArray(args.dimensions) && args.dimensions.length ? { dimensions: args.dimensions.map(String) } : {}),
          ...(args.start_date ? { startDate: String(args.start_date) } : {}),
          ...(args.end_date ? { endDate: String(args.end_date) } : {}),
          ...(args.max_results !== undefined ? { maxResults: Number(args.max_results) } : {}),
        },
        proxy,
      ),
  },
  {
    capability: 'salesforce',
    name: 'salesforce_create_record',
    description: 'Create a Salesforce record (e.g. Task, Event) via the connected account.',
    inputSchema: {
      type: 'object',
      properties: {
        sobject: { type: 'string', description: 'SObject API name, e.g. Task.' },
        fields: { type: 'object', description: 'Field name/value map for the new record.' },
      },
      required: ['sobject', 'fields'],
    },
    run: (connection, args, proxy) =>
      salesforceCreateRecord(
        connection,
        { sobject: String(args.sobject), fields: (args.fields as Record<string, unknown>) ?? {} },
        proxy,
      ),
  },
  {
    capability: 'asana',
    name: 'asana_create_task',
    description: 'Create a task in an Asana project via the connected account.',
    inputSchema: {
      type: 'object',
      properties: {
        project_gid: { type: 'string', description: 'The Asana project gid the task belongs to.' },
        name: { type: 'string', description: 'Task title.' },
        notes: { type: 'string', description: 'Optional task description.' },
      },
      required: ['project_gid', 'name'],
    },
    run: (connection, args, proxy) =>
      asanaCreateTask(
        connection,
        { projectGid: String(args.project_gid), name: String(args.name), ...(args.notes ? { notes: String(args.notes) } : {}) },
        proxy,
      ),
  },
  {
    capability: 'clickup',
    name: 'clickup_create_task',
    description: 'Create a task in a ClickUp list via the connected account.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The ClickUp list id the task belongs to.' },
        name: { type: 'string', description: 'Task title.' },
        description: { type: 'string', description: 'Optional task description.' },
      },
      required: ['list_id', 'name'],
    },
    run: (connection, args, proxy) =>
      clickupCreateTask(
        connection,
        { listId: String(args.list_id), name: String(args.name), ...(args.description ? { description: String(args.description) } : {}) },
        proxy,
      ),
  },
  {
    capability: 'confluence',
    name: 'confluence_create_page',
    description: 'Create a Confluence page in a space via the connected account.',
    inputSchema: {
      type: 'object',
      properties: {
        space_id: { type: 'string', description: 'The Confluence space id.' },
        title: { type: 'string', description: 'Page title.' },
        body: { type: 'string', description: 'Page body in Confluence storage format (HTML-like) or plain text.' },
      },
      required: ['space_id', 'title', 'body'],
    },
    run: (connection, args, proxy) =>
      confluenceCreatePage(
        connection,
        { spaceId: String(args.space_id), title: String(args.title), body: String(args.body) },
        proxy,
      ),
  },
  {
    capability: 'github',
    name: 'github_create_issue',
    description: 'Open a GitHub issue in a repository via the connected account.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (user or org).' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Optional issue body (markdown).' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (connection, args, proxy) =>
      githubCreateIssue(
        connection,
        { owner: String(args.owner), repo: String(args.repo), title: String(args.title), ...(args.body ? { body: String(args.body) } : {}) },
        proxy,
      ),
  },
  {
    capability: 'intercom',
    name: 'intercom_search_contacts',
    description: 'Look up Intercom contacts by email via the connected account.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address to search for.' },
      },
      required: ['email'],
    },
    run: (connection, args, proxy) => intercomSearchContacts(connection, { email: String(args.email) }, proxy),
  },
  {
    capability: 'monday',
    name: 'monday_create_item',
    description: 'Create an item on a monday.com board via the connected account.',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: { type: 'string', description: 'The monday.com board id.' },
        item_name: { type: 'string', description: 'Name of the new item.' },
      },
      required: ['board_id', 'item_name'],
    },
    run: (connection, args, proxy) =>
      mondayCreateItem(connection, { boardId: String(args.board_id), itemName: String(args.item_name) }, proxy),
  },
  {
    capability: 'perplexity',
    name: 'perplexity_search',
    description: 'Ask Perplexity (sonar) a question and get a web-grounded answer via the connected account.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question to research.' },
      },
      required: ['query'],
    },
    run: (connection, args, proxy) => perplexitySearch(connection, { query: String(args.query) }, proxy),
  },
  {
    capability: 'slack',
    name: 'slack_update_message',
    description: 'Edit an existing Slack message the connected account posted.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id containing the message.' },
        ts: { type: 'string', description: 'Timestamp id of the message to edit.' },
        text: { type: 'string', description: 'Replacement message text.' },
      },
      required: ['channel', 'ts', 'text'],
    },
    run: (connection, args, proxy) =>
      slackUpdateMessage(connection, { channel: String(args.channel), ts: String(args.ts), text: String(args.text) }, proxy),
  },
  {
    capability: 'slack',
    name: 'slack_get_channel_history',
    description: 'Read recent messages from a Slack channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id.' },
        limit: { type: 'number', description: 'Max messages to return (default 100).' },
      },
      required: ['channel'],
    },
    run: (connection, args, proxy) =>
      slackGetChannelHistory(connection, { channel: String(args.channel), ...(args.limit ? { limit: Number(args.limit) } : {}) }, proxy),
  },
  {
    capability: 'slack',
    name: 'slack_add_reaction',
    description: 'Add an emoji reaction to a Slack message.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id containing the message.' },
        timestamp: { type: 'string', description: 'Timestamp id of the message.' },
        name: { type: 'string', description: 'Emoji name without colons (e.g. tada).' },
      },
      required: ['channel', 'timestamp', 'name'],
    },
    run: (connection, args, proxy) =>
      slackAddReaction(connection, { channel: String(args.channel), timestamp: String(args.timestamp), name: String(args.name) }, proxy),
  },
  {
    capability: 'gmail',
    name: 'gmail_get_message',
    description: 'Fetch one Gmail message by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Gmail message id.' } },
      required: ['id'],
    },
    run: (connection, args, proxy) => gmailGetMessage(connection, { id: String(args.id) }, proxy),
  },
  {
    capability: 'gmail',
    name: 'gmail_list_messages',
    description: 'List Gmail messages matching a search query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query (e.g. from:a@b.co is:unread).' },
        max_results: { type: 'number', description: 'Max messages to return.' },
      },
    },
    run: (connection, args, proxy) =>
      gmailListMessages(connection, {
        ...(args.query ? { query: String(args.query) } : {}),
        ...(args.max_results ? { maxResults: Number(args.max_results) } : {}),
      }, proxy),
  },
  {
    capability: 'gmail',
    name: 'gmail_trash_message',
    description: 'Move a Gmail message to the trash.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Gmail message id.' } },
      required: ['id'],
    },
    run: (connection, args, proxy) => gmailTrashMessage(connection, { id: String(args.id) }, proxy),
  },
  {
    capability: 'sheets',
    name: 'sheets_clear_values',
    description: 'Clear a cell range in a Google Sheet (A1 notation).',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The spreadsheet id (from its URL).' },
        range: { type: 'string', description: 'A1-notation range to clear.' },
      },
      required: ['spreadsheet_id', 'range'],
    },
    run: (connection, args, proxy) =>
      sheetsClearValues(connection, { spreadsheetId: String(args.spreadsheet_id), range: String(args.range) }, proxy),
  },
  {
    capability: 'salesforce',
    name: 'salesforce_update_record',
    description: 'Update fields on an existing Salesforce record.',
    inputSchema: {
      type: 'object',
      properties: {
        sobject: { type: 'string', description: 'Object API name (Lead, Contact, Account, …).' },
        id: { type: 'string', description: 'Record id.' },
        fields: { type: 'object', description: 'Field name → new value.' },
      },
      required: ['sobject', 'id', 'fields'],
    },
    run: (connection, args, proxy) =>
      salesforceUpdateRecord(connection, {
        sobject: String(args.sobject), id: String(args.id),
        fields: (args.fields && typeof args.fields === 'object' ? args.fields : {}) as Record<string, unknown>,
      }, proxy),
  },
  {
    capability: 'salesforce',
    name: 'salesforce_get_record',
    description: 'Fetch one Salesforce record by id.',
    inputSchema: {
      type: 'object',
      properties: {
        sobject: { type: 'string', description: 'Object API name (Lead, Contact, Account, …).' },
        id: { type: 'string', description: 'Record id.' },
      },
      required: ['sobject', 'id'],
    },
    run: (connection, args, proxy) =>
      salesforceGetRecord(connection, { sobject: String(args.sobject), id: String(args.id) }, proxy),
  },
  {
    capability: 'salesforce',
    name: 'salesforce_query',
    description: 'Run a SOQL query against the connected Salesforce org.',
    inputSchema: {
      type: 'object',
      properties: { soql: { type: 'string', description: 'SOQL query (SELECT … FROM …).' } },
      required: ['soql'],
    },
    run: (connection, args, proxy) => salesforceQuery(connection, { soql: String(args.soql) }, proxy),
  },
]

/**
 * The spec for a named tool on a capability. Capabilities may expose several
 * tools (sheets/drive/calendar do) — callers must dispatch by name, never by
 * "the capability's spec".
 */
export function deliverySpecByName(capability: DeliveryCapability, name: string): DeliveryToolSpec | undefined {
  return DELIVERY_TOOLS.find((tool) => tool.capability === capability && tool.name === name)
}

export { nangoConfigured }
