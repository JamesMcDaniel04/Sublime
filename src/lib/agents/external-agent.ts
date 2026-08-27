/**
 * The contract Sublime speaks to an external agent (BYOA, outbound).
 *
 * An external agent is a teammate whose work runs somewhere else — a Claude
 * Agent SDK service, a Managed Agent behind a thin adapter, a function. It
 * joins the roster like any agent: it has a face, a role, people address it,
 * and its answers land back on the request, the goal, and the Slack thread.
 * The only difference is that instead of Sublime's tool loop, each ask is
 * POSTed to the agent's endpoint and the answer comes back inline or through
 * a callback.
 *
 * Everything here is pure (no I/O) except dispatchToExternalAgent, which
 * takes an injectable fetch. The full contract is in docs/external-agents.md.
 */
import crypto from 'node:crypto'
import { decryptSecret, encryptSecret, hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { assertPublicUrl, fetchPublicUrl } from '@/lib/net/ssrf'

export const EXTERNAL_PROTOCOL = 'sublime-external-agent/1'
export const EXTERNAL_AUTH_TYPES = ['none', 'bearer', 'header'] as const
export type ExternalAuthType = (typeof EXTERNAL_AUTH_TYPES)[number]
export const DEFAULT_EXTERNAL_TIMEOUT_MINUTES = 10
export const MAX_EXTERNAL_TIMEOUT_MINUTES = 24 * 60
/** How long the initial POST may take. An agent that needs longer answers 202 and calls back. */
export const EXTERNAL_DISPATCH_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 50_000
/** Work entries an answer may carry. Bounded like every other inbound list. */
export const MAX_WORK_ENTRIES = 20
const MAX_WORK_FIELD_CHARS = 200
const MAX_WORK_BODY_CHARS = 50_000

/**
 * A unit of tracked work the agent declares alongside its answer — for a
 * coding agent, one pull request. Lands on the request's goal through the
 * same GoalWork path a native agent's log_work uses, so it enters the
 * disposition ledger and the rule learning like any other agent output.
 */
export type ExternalWorkEntry = {
  subject: string
  produced: string
  body: string | null
  bodyFormat: 'markdown' | 'html'
  /** Stable external id (a PR id) so a re-run does not file the same work twice. */
  subjectRef: string | null
  /** A name or email; resolved server-side, never an error when unknown. */
  assigneeHint: string | null
}

const str = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null

/** Pure, fail-safe: junk entries are dropped, the list is capped, nothing throws. */
export function parseWorkEntries(value: unknown): ExternalWorkEntry[] {
  if (!Array.isArray(value)) return []
  const out: ExternalWorkEntry[] = []
  for (const raw of value.slice(0, MAX_WORK_ENTRIES)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const subject = str(entry.subject, MAX_WORK_FIELD_CHARS)
    const produced = str(entry.produced, MAX_WORK_FIELD_CHARS)
    if (!subject || !produced) continue
    out.push({
      subject,
      produced,
      body: str(entry.body, MAX_WORK_BODY_CHARS),
      bodyFormat: entry.bodyFormat === 'html' ? 'html' : 'markdown',
      subjectRef: str(entry.subjectRef, MAX_WORK_FIELD_CHARS),
      assigneeHint: str(entry.assigneeHint, MAX_WORK_FIELD_CHARS),
    })
  }
  return out
}

export type ExternalDispatchPayload = {
  protocol: typeof EXTERNAL_PROTOCOL
  runId: string
  agentId: string
  /** The human ask this run answers, when there is one. */
  request: { id: string; text: string; requesterName: string | null } | null
  /** The agent's standing job, so the service can frame the ask the way a native run would. */
  objective: string
  input: string
  /** The goal the ask belongs to, if any — where returned `work` will land. Null means work is dropped. */
  goalId: string | null
  callbackUrl: string
  /** Single-use, bound to this run. Present it as x-callback-token. */
  callbackToken: string
}

export function buildExternalPayload(args: Omit<ExternalDispatchPayload, 'protocol'>): ExternalDispatchPayload {
  return { protocol: EXTERNAL_PROTOCOL, ...args }
}

/** A fresh callback token and the hash Sublime stores. The token itself is never persisted. */
export function mintCallbackToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('hex')
  return { token, hash: hashToken(token) }
}

export function verifyCallbackToken(presented: string | null | undefined, hash: string | null | undefined): boolean {
  if (!presented || !hash) return false
  return timingSafeEqualHex(hashToken(presented), hash)
}

/** Where the agent posts its result. Needs an app origin; without one the path is relative and documented as such. */
export function callbackUrlFor(agentId: string, base = process.env.NEXT_PUBLIC_APP_URL): string {
  const path = `/api/agents/${agentId}/external/callback`
  return base ? `${base.replace(/\/$/, '')}${path}` : path
}

export type ExternalOutcome =
  | { kind: 'completed'; output: string; work: ExternalWorkEntry[] }
  | { kind: 'accepted' }
  | { kind: 'failed'; error: string }

/**
 * What the endpoint's response means.
 *
 *   200 + { output }            — answered inline
 *   200 + { status: 'failed' }  — the agent tried and could not
 *   202                         — accepted; the answer arrives via callback
 *   anything else               — failed, with the status for the requester
 */
export function interpretExternalResponse(status: number, body: unknown): ExternalOutcome {
  if (status === 202) return { kind: 'accepted' }
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  if (status >= 200 && status < 300) {
    if (record?.status === 'failed') return { kind: 'failed', error: String(record.error ?? 'The external agent reported a failure.').slice(0, 500) }
    const output = record?.output
    const work = parseWorkEntries(record?.work)
    if (typeof output === 'string' && output.trim()) return { kind: 'completed', output: output.slice(0, MAX_OUTPUT_CHARS), work }
    if (output !== undefined && output !== null) return { kind: 'completed', output: JSON.stringify(output).slice(0, MAX_OUTPUT_CHARS), work }
    return { kind: 'failed', error: 'The external agent answered without an output.' }
  }
  return { kind: 'failed', error: `The external agent responded with HTTP ${status}.` }
}

/** The result the callback route accepts. */
export function interpretCallbackBody(body: unknown): ExternalOutcome {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  if (record.status === 'failed') return { kind: 'failed', error: String(record.error ?? 'The external agent reported a failure.').slice(0, 500) }
  return interpretExternalResponse(200, record)
}

/** Stored shape of a binding's auth. The secret is ciphertext at rest. */
export function encryptExternalAuth(input: { authType: ExternalAuthType; headerName?: string | null; secret?: string | null }): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (input.authType === 'header' && input.headerName) out.headerName = input.headerName.trim()
  if (input.authType !== 'none' && input.secret) out.secretEnc = encryptSecret(input.secret)
  return out
}

export function authHeadersFor(binding: { authType: string; authConfig: unknown }): Record<string, string> {
  const config = binding.authConfig && typeof binding.authConfig === 'object' ? (binding.authConfig as Record<string, unknown>) : {}
  const secret = typeof config.secretEnc === 'string' ? decryptSecret(config.secretEnc) : null
  if (!secret) return {}
  if (binding.authType === 'bearer') return { authorization: `Bearer ${secret}` }
  if (binding.authType === 'header') {
    const name = typeof config.headerName === 'string' && config.headerName.trim() ? config.headerName.trim() : 'x-api-key'
    return { [name]: secret }
  }
  return {}
}

/** What the API and UI may see of a binding — never the secret. */
export function describeExternalBinding(binding: { endpointUrl: string; authType: string; authConfig: unknown; timeoutMinutes: number } | null | undefined) {
  if (!binding) return null
  const config = binding.authConfig && typeof binding.authConfig === 'object' ? (binding.authConfig as Record<string, unknown>) : {}
  let host = ''
  try { host = new URL(binding.endpointUrl).host } catch { host = binding.endpointUrl }
  return {
    endpointUrl: binding.endpointUrl,
    host,
    authType: binding.authType,
    headerName: typeof config.headerName === 'string' ? config.headerName : null,
    hasSecret: typeof config.secretEnc === 'string',
    timeoutMinutes: binding.timeoutMinutes,
  }
}

/**
 * POST the ask to the endpoint. The URL is re-vetted on every call (a host
 * can change what it resolves to after save) and the connection is pinned to
 * the vetted address, so a DNS rebind cannot turn this into a request to
 * the metadata service.
 */
export async function dispatchToExternalAgent(args: {
  endpointUrl: string
  headers: Record<string, string>
  payload: ExternalDispatchPayload
  fetchImpl?: typeof fetch
}): Promise<ExternalOutcome> {
  try {
    await assertPublicUrl(args.endpointUrl)
  } catch (error) {
    return { kind: 'failed', error: `Endpoint refused: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }
  }
  let response: Response
  try {
    response = await fetchPublicUrl(
      args.endpointUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...args.headers },
        body: JSON.stringify(args.payload),
        signal: AbortSignal.timeout(EXTERNAL_DISPATCH_TIMEOUT_MS),
      },
      args.fetchImpl ?? fetch,
    )
  } catch (error) {
    return { kind: 'failed', error: `Could not reach the external agent: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }
  }
  const body = await response.json().catch(() => null)
  return interpretExternalResponse(response.status, body)
}
