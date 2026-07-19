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
}

/** Provider config keys we treat as delivery targets, by capability. */
export const DELIVERY_PROVIDERS = {
  slack: ['slack'],
  gmail: ['google-mail', 'gmail'],
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
 * Resolve the connection to use for a capability: the acting user's own
 * connection first, then any org connection. Matches provider config keys for
 * the capability.
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

  const own = userId ? connections.find((connection) => connection.userId === userId) : undefined
  const chosen = own ?? connections.find((connection) => !connection.userId) ?? connections[0]
  return {
    connectionId: chosen.connectionId,
    providerConfigKey: chosen.providerConfigKey,
    scope: chosen.userId === userId && userId ? 'user' : 'org',
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
]

export { nangoConfigured }
