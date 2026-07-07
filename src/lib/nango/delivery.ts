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
} as const

export type DeliveryCapability = keyof typeof DELIVERY_PROVIDERS

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
]

export { nangoConfigured }
