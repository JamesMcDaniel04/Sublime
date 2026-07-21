/**
 * Granola ActivitySource — meeting notes into the activity ledger. The
 * existing Granola integration is a read-live tool plane (agents can fetch
 * notes on demand); this is the LEARNING leg: backfill + daily incremental
 * sync of `took_meeting_notes` events, feeding the usage-evidence gate and
 * persona (granola anchors sales/csm), plus fire-and-forget distillation of
 * new notes into the knowledge substrate (see knowledge/notes-distill.ts).
 *
 * Auth is the org's Granola API key (IntegrationSecret, not Nango) — the
 * SourceContext connectionRef is the constant 'granola'. Only note METADATA
 * and the AI summary are touched; transcripts are never ingested.
 */
import { apiLogger } from '@/lib/logger'
import { GRANOLA_BASE_URL, getGranolaApiKey } from '@/lib/integrations/granola'
import {
  windowStart,
  type ActivitySource,
  type BackfillBatch,
  type BackfillWindow,
  type NormalizedActivity,
  type SourceContext,
} from '../types'

export const GRANOLA_SOURCE = 'granola'
export const GRANOLA_CONNECTION_REF = 'granola'

const CALL_TIMEOUT_MS = 30_000
const SYNC_MAX_PAGES = 2

export type GranolaNote = {
  id: string
  title: string
  summary: string
  ownerRef: string
  ownerName: string | null
  attendees: string[]
  createdAt: Date
}

/**
 * Recurring-series key for a meeting title: dates, times, and counters vary
 * per occurrence; the series name is what recurs ("Acme sync 7/14" and
 * "Acme sync 7/21" are the same series). Pure.
 */
export function meetingSeriesKey(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/\d{1,4}[/\-.]\d{1,2}([/\-.]\d{1,4})?/g, ' ')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\s*(am|pm)?\b/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || 'meeting').slice(0, 60)
}

/** Defensive parse of one API note row; null when essentials are missing. */
export function parseGranolaNote(raw: unknown): GranolaNote | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : null
  const createdRaw = typeof row.created_at === 'string' ? row.created_at : typeof row.createdAt === 'string' ? row.createdAt : null
  const createdAt = createdRaw ? new Date(createdRaw) : null
  if (!id || !createdAt || Number.isNaN(createdAt.getTime())) return null
  const owner = row.owner
  const ownerRef =
    typeof owner === 'string'
      ? owner
      : owner && typeof owner === 'object' && typeof (owner as { email?: unknown }).email === 'string'
        ? ((owner as { email: string }).email)
        : 'unknown'
  const ownerName =
    owner && typeof owner === 'object' && typeof (owner as { name?: unknown }).name === 'string'
      ? ((owner as { name: string }).name)
      : null
  const attendees = (Array.isArray(row.attendees) ? row.attendees : [])
    .map((attendee) =>
      typeof attendee === 'string'
        ? attendee
        : attendee && typeof attendee === 'object' && typeof (attendee as { email?: unknown }).email === 'string'
          ? ((attendee as { email: string }).email)
          : null,
    )
    .filter((email): email is string => Boolean(email))
    .slice(0, 20)
  const summary = typeof row.summary === 'string' ? row.summary : typeof row.ai_summary === 'string' ? row.ai_summary : ''
  return {
    id,
    title: typeof row.title === 'string' ? row.title : 'Untitled meeting',
    summary,
    ownerRef,
    ownerName,
    attendees,
    createdAt,
  }
}

export function granolaNoteActivity(note: GranolaNote): NormalizedActivity {
  return {
    source: GRANOLA_SOURCE,
    actorRef: note.ownerRef,
    actorName: note.ownerName,
    action: 'took_meeting_notes',
    entityType: 'meeting_note',
    entityRef: note.id,
    entityName: note.title.slice(0, 200),
    participants: note.attendees,
    businessContext: { series: meetingSeriesKey(note.title) },
    occurredAt: note.createdAt,
    dedupeKey: `granola:note:${note.id}`,
  }
}

type NotesPage = { notes: GranolaNote[]; nextCursor?: string }

export type GranolaFetchPage = (
  organizationId: string,
  params: { createdAfter?: string; cursor?: string },
) => Promise<NotesPage>

async function fetchNotesPage(
  organizationId: string,
  params: { createdAfter?: string; cursor?: string },
): Promise<NotesPage> {
  const key = await getGranolaApiKey(organizationId)
  if (!key) return { notes: [] }
  const search = new URLSearchParams()
  if (params.createdAfter) search.set('created_after', params.createdAfter)
  if (params.cursor) search.set('cursor', params.cursor)
  const qs = search.toString()
  const response = await fetch(`${GRANOLA_BASE_URL}/notes${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${key.apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Granola API error ${response.status}`)
  const body = (await response.json()) as Record<string, unknown>
  const rows = Array.isArray(body.notes) ? body.notes : Array.isArray(body.data) ? body.data : Array.isArray(body.results) ? body.results : []
  const nextCursor =
    typeof body.next_cursor === 'string' ? body.next_cursor : typeof body.cursor === 'string' ? body.cursor : undefined
  return {
    notes: rows.map((row) => parseGranolaNote(row)).filter((note): note is GranolaNote => note !== null),
    nextCursor,
  }
}

/** Fire-and-forget distillation of a page of notes; never blocks ingestion. */
function distill(organizationId: string, notes: GranolaNote[]): void {
  if (notes.length === 0) return
  void import('@/lib/knowledge/notes-distill')
    .then(({ distillNewMeetingNotes }) => distillNewMeetingNotes(organizationId, notes))
    .catch((error) =>
      apiLogger.warn('granola: note distillation failed', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
}

export function makeGranolaActivitySource(fetchPageOverride?: GranolaFetchPage): ActivitySource {
  const fetchPage = fetchPageOverride ?? fetchNotesPage
  return {
    source: GRANOLA_SOURCE,
    capabilities: { backfill: true, webhooks: false, incrementalSync: true },
    async *backfill(ctx: SourceContext, window: BackfillWindow, cursor?: string): AsyncIterable<BackfillBatch> {
      const since = windowStart(window, new Date())
      let pageCursor = cursor
      do {
        let page: NotesPage
        try {
          page = await fetchPage(ctx.organizationId, {
            ...(since ? { createdAfter: since.toISOString() } : {}),
            ...(pageCursor ? { cursor: pageCursor } : {}),
          })
        } catch (error) {
          apiLogger.warn('granola backfill: page fetch failed, stopping run', {
            error: error instanceof Error ? error.message : String(error),
          })
          yield { events: [], ...(pageCursor ? { nextCursor: pageCursor } : {}) }
          return
        }
        distill(ctx.organizationId, page.notes)
        pageCursor = page.nextCursor
        yield {
          events: page.notes.map((note) => granolaNoteActivity(note)),
          ...(pageCursor ? { nextCursor: pageCursor } : {}),
        }
      } while (pageCursor)
    },
    async handleEvent() {
      return []
    },
    async incrementalSync(ctx: SourceContext, since: Date): Promise<NormalizedActivity[]> {
      const events: NormalizedActivity[] = []
      let pageCursor: string | undefined
      let pages = 0
      try {
        do {
          const page = await fetchPage(ctx.organizationId, {
            createdAfter: since.toISOString(),
            ...(pageCursor ? { cursor: pageCursor } : {}),
          })
          distill(ctx.organizationId, page.notes)
          for (const note of page.notes) events.push(granolaNoteActivity(note))
          pageCursor = page.nextCursor
          pages += 1
        } while (pageCursor && pages < SYNC_MAX_PAGES)
      } catch (error) {
        apiLogger.warn('granola incremental sync failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return events
    },
  }
}

export const granolaActivitySource = makeGranolaActivitySource()
