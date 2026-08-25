/**
 * Email as a flow trigger.
 *
 * **Delivered over the Gmail API, not IMAP.** IMAP would need a protocol
 * client dependency and a long-lived connection that neither the serverless
 * runtime nor a stateless worker holds well. Gmail is HTTP with an OAuth token
 * this platform already stores (GoogleOAuthConnection, service 'google-mail'),
 * so this reuses infrastructure rather than adding any.
 *
 * The narrowing is real: a self-hosted or non-Google mailbox is not covered.
 * Microsoft Graph is the natural second driver and fits the same shape — the
 * parsing and identity rules below are provider-agnostic on purpose.
 *
 * **The property everything here serves is exactly-once.** A message that
 * triggers twice means a duplicate reply sent, a duplicate ticket filed, a
 * duplicate charge. That is the failure people actually notice, and it is why
 * identity is the immutable message id rather than anything about the content.
 */

export interface EmailTriggerConfig {
  /** A complete Gmail search, used verbatim when present. */
  query?: string
  from?: string
  subject?: string
  label?: string
  /** Poll read mail too. Opt-in: this is what floods a flow on first run. */
  includeRead?: boolean
}

/**
 * Quote a value so it cannot change the query's meaning.
 *
 * A subject containing `-in:trash` or a stray quote would otherwise escape its
 * term and silently redefine what the trigger matches.
 */
function term(value: string): string {
  return `"${value.replace(/"/g, '')}"`
}

export function gmailQueryFor(config: EmailTriggerConfig): string {
  // A raw query is used as given. Someone who wrote a Gmail search means it,
  // and second-guessing it produces a filter they cannot reason about.
  if (config.query?.trim()) return config.query.trim()

  const parts = ['in:inbox']
  if (!config.includeRead) parts.push('is:unread')
  if (config.from?.trim()) parts.push(`from:${term(config.from.trim())}`)
  if (config.subject?.trim()) parts.push(`subject:${term(config.subject.trim())}`)
  if (config.label?.trim()) parts.push(`label:${term(config.label.trim())}`)
  return parts.join(' ')
}

export interface ParsedEmail {
  id: string
  threadId: string
  from: string
  to: string
  subject: string
  body: string
  receivedAt: string
}

/** Bounded so a large email never lands whole in a run row. */
const MAX_BODY_CHARS = 50_000

interface GmailPart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPart[]
}

function headerValue(headers: { name?: string; value?: string }[] | undefined, name: string): string {
  const target = name.toLowerCase()
  // Case-insensitively: header casing is not guaranteed by anything.
  return headers?.find((header) => header.name?.toLowerCase() === target)?.value ?? ''
}

/** The first text/plain part, depth-first — HTML is a poor prompt input. */
function plainTextPart(part: GmailPart | undefined): string | undefined {
  if (!part) return undefined
  if (part.mimeType === 'text/plain' && part.body?.data) return part.body.data
  for (const child of part.parts ?? []) {
    const found = plainTextPart(child)
    if (found) return found
  }
  return undefined
}

export function parseGmailMessage(message: Record<string, unknown>): ParsedEmail {
  const payload = (message.payload ?? {}) as GmailPart & { headers?: { name?: string; value?: string }[] }
  const encoded = plainTextPart(payload) ?? payload.body?.data

  const body = encoded
    ? Buffer.from(encoded, 'base64url').toString('utf8')
    // No body part at all: the snippet is better than nothing, and is what a
    // person sees in the mailbox list.
    : String(message.snippet ?? '')

  const internalDate = Number(message.internalDate)

  return {
    id: String(message.id ?? ''),
    threadId: String(message.threadId ?? ''),
    from: headerValue(payload.headers, 'From'),
    to: headerValue(payload.headers, 'To'),
    subject: headerValue(payload.headers, 'Subject'),
    body: body.slice(0, MAX_BODY_CHARS),
    receivedAt: Number.isFinite(internalDate) && internalDate > 0
      ? new Date(internalDate).toISOString()
      : '',
  }
}

/**
 * What makes a message the same message.
 *
 * The provider's immutable id, deliberately — not the subject, sender or
 * timestamp. Those collide across genuinely distinct messages (a newsletter
 * sends the same subject to everyone) and they change when a message is
 * re-delivered, so either mistake produces a duplicate trigger.
 */
export function messageIdentity(message: ParsedEmail): string {
  return message.id
}
