/**
 * Map People.ai SalesAI webhook payloads to Signal rows.
 *
 * SEAM: field names follow the SalesAI API & Developer Guide's payload
 * examples with defensive fallbacks for flat/nested/camel variants. If the
 * live payloads differ, adjust the key lists here — the router and receiver
 * only see the normalized shape.
 */

import crypto from 'node:crypto'

export const SIGNAL_TYPES = [
  'deal.score_updated',
  'deal.risk_detected',
  'deal.stage_changed',
  'forecast.updated',
  'insight.generated',
  'stakeholder.engagement_changed',
] as const

export type SignalType = (typeof SIGNAL_TYPES)[number]

export interface MappedSignal {
  type: SignalType
  accountId: string | null
  opportunityId: string | null
  stakeholderId: string | null
  dedupeKey: string
  provenanceUrl: string | null
  payload: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function firstString(sources: Record<string, unknown>[], keys: string[]): string | null {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key]
      if (typeof value === 'string' && value) return value
      if (typeof value === 'number') return String(value)
    }
  }
  return null
}

export function mapEventToSignal(rawPayload: unknown): MappedSignal | null {
  const payload = asRecord(rawPayload)
  const data = asRecord(payload.data)

  const type = firstString([payload, data], ['type', 'event', 'event_type'])
  if (!type || !(SIGNAL_TYPES as readonly string[]).includes(type)) return null

  const sources = [data, payload]
  const eventId = firstString([payload, data], ['id', 'event_id', 'eventId'])
  const dedupeKey =
    eventId ??
    `sha256:${crypto.createHash('sha256').update(`${type}:${JSON.stringify(payload)}`).digest('hex')}`

  return {
    type: type as SignalType,
    accountId: firstString(sources, ['account_id', 'accountId']),
    opportunityId: firstString(sources, ['opportunity_id', 'opportunityId', 'deal_id', 'dealId']),
    stakeholderId: firstString(sources, ['stakeholder_id', 'stakeholderId', 'person_id', 'personId']),
    dedupeKey,
    provenanceUrl: firstString(sources, ['url', 'link', 'provenance_url', 'permalink']),
    payload,
  }
}
