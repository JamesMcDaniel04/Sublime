import { prisma } from '@/lib/prisma'
import { decryptSecret } from '@/lib/crypto/secrets'
import { refreshAccessToken } from '@/lib/google/oauth'
import { takeUnseen } from '@/features/flows/static-store'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { gmailQueryFor, parseGmailMessage, type EmailTriggerConfig, type ParsedEmail } from '@/lib/triggers/email'

/**
 * Poll a mailbox and start a flow run per new message.
 *
 * **Exactly-once is the whole job.** A message that triggers twice means a
 * duplicate reply sent or a duplicate ticket filed, so dedupe runs through
 * `takeUnseen` — the same cross-run store the dedupe node uses, which claims
 * ids inside a transaction with SELECT … FOR UPDATE. Two concurrent polls of
 * the same flow therefore cannot both decide a message is new.
 *
 * Dedupe happens BEFORE dispatch, deliberately. Claiming first risks losing a
 * message if dispatch then fails; claiming after risks sending twice if the
 * poller dies mid-loop. Between "possibly missed" and "possibly duplicated", a
 * missed message is the recoverable failure — it is still sitting in the
 * mailbox, and a widened query finds it. A duplicate reply cannot be unsent.
 */

const MAX_PER_POLL = 25

interface GmailListResponse {
  messages?: { id: string }[]
}

async function accessTokenFor(connectionId: string, organizationId: string): Promise<string> {
  const connection = await prisma.googleOAuthConnection.findFirst({
    where: { id: connectionId, organizationId, status: 'connected' },
    select: { refreshTokenEnc: true },
  })
  if (!connection) throw new Error('That mailbox connection is not available.')
  const { accessToken } = await refreshAccessToken(decryptSecret(connection.refreshTokenEnc))
  return accessToken
}

async function gmail(path: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    // The status only: a Gmail error body can carry the query and the token
    // prefix, and this message reaches the flow's error surface.
    throw new Error(`The mailbox could not be read (HTTP ${response.status}).`)
  }
  return await response.json() as Record<string, unknown>
}

export interface EmailPollResult {
  checked: number
  triggered: number
}

export async function pollEmailTrigger(params: {
  flowId: string
  organizationId: string
  userId: string
  connectionId: string
  config: EmailTriggerConfig
}): Promise<EmailPollResult> {
  const token = await accessTokenFor(params.connectionId, params.organizationId)
  const query = encodeURIComponent(gmailQueryFor(params.config))

  const list = await gmail(`messages?q=${query}&maxResults=${MAX_PER_POLL}`, token) as GmailListResponse
  const ids = (list.messages ?? []).map((message) => message.id).filter(Boolean)
  if (ids.length === 0) return { checked: 0, triggered: 0 }

  // Claimed BEFORE the message bodies are fetched: the id is all dedupe needs,
  // and claiming first means a crash mid-fetch cannot re-trigger.
  const { fresh } = await takeUnseen(
    params.organizationId,
    params.flowId,
    ids.map((id) => ({ id })),
    'id',
  )
  if (fresh.length === 0) return { checked: ids.length, triggered: 0 }

  let triggered = 0
  for (const entry of fresh) {
    const id = (entry as { id: string }).id
    let message: ParsedEmail
    try {
      message = parseGmailMessage(await gmail(`messages/${encodeURIComponent(id)}?format=full`, token))
    } catch {
      // A message that cannot be fetched is skipped rather than failing the
      // whole poll — one unreadable message must not stop every other one.
      continue
    }

    await dispatchFlowExecution({
      flowId: params.flowId,
      organizationId: params.organizationId,
      userId: params.userId,
      input: message,
      trigger: { type: 'email', messageId: message.id },
      // The provider's id, so a retried dispatch cannot double-run even if the
      // claim above were somehow replayed.
      idempotencyKey: `email:${params.flowId}:${message.id}`,
    } as never, { background: true })
    triggered++
  }

  return { checked: ids.length, triggered }
}
