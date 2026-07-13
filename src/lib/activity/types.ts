/**
 * Source-agnostic activity contract (spec §4–5). Every connected tool that
 * participates in integration learnings implements ActivitySource; every
 * event — historical or live — normalizes to NormalizedActivity before it
 * touches the ledger, the graph, or flow triggers.
 */

export type IngestKind = 'backfill' | 'webhook' | 'sync'
export type BackfillWindow = '90d' | '1y' | 'all'

export interface NormalizedActivity {
  source: string
  actorRef: string
  actorName?: string | null
  action: string
  entityType: string
  entityRef: string
  entityName?: string | null
  previousState?: unknown
  newState?: unknown
  participants?: string[]
  businessContext?: Record<string, unknown>
  outcome?: string | null
  occurredAt: Date
  /** Provider event id or stable content hash. Unique per org. */
  dedupeKey: string
}

/** Inclusive start of a backfill window; null = all available history. */
export function windowStart(window: BackfillWindow, now: Date): Date | null {
  if (window === 'all') return null
  const days = window === '90d' ? 90 : 365
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

/** Credential handle passed to adapters — adapters never hold raw tokens
 * beyond the call. connectionRef identifies the integration-plane row. */
export interface SourceContext {
  organizationId: string
  connectionRef: string
}

export interface BackfillBatch {
  events: NormalizedActivity[]
  /** Absent/undefined = backfill complete. */
  nextCursor?: string
}

export interface ActivitySource {
  source: string
  capabilities: { backfill: boolean; webhooks: boolean; incrementalSync: boolean }
  backfill(ctx: SourceContext, window: BackfillWindow, cursor?: string): AsyncIterable<BackfillBatch>
  /** Translate one already-verified provider payload into 0..n events. */
  handleEvent(ctx: SourceContext, payload: unknown): Promise<NormalizedActivity[]>
  incrementalSync(ctx: SourceContext, since: Date): Promise<NormalizedActivity[]>
}
