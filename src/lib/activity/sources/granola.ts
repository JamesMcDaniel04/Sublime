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
// Backfill bounds: a runaway or misbehaving pagination cursor must not walk
// forever. The ledger's dedupeKey means a re-run resumes cheaply, so a hard
// per-run page cap is safe.
const BACKFILL_MAX_PAGES = 40
const MAX_FETCH_RETRIES = 3
const RETRY_BASE_MS = 500
const MAX_RETRY_DELAY_MS = 10_000

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const backoffMs = (attempt: number) => Math.min(RETRY_BASE_MS * 2 ** attempt, MAX_RETRY_DELAY_MS)

/** Parsed Retry-After: seconds form only (the delta-seconds Granola sends). */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS) : null
}

/** Normalize one notes-list response body across the field spellings the
 *  public API might use (notes/data/results, next_cursor/cursor). */
function parseNotesBody(body: Record<string, unknown>): NotesPage {
  const firstArray = [body.notes, body.data, body.results].find((value): value is unknown[] => Array.isArray(value)) ?? []
  const cursorValue = [body.next_cursor, body.cursor].find((value): value is string => typeof value === 'string')
  return {
    notes: firstArray.map((row) => parseGranolaNote(row)).filter((note): note is GranolaNote => note !== null),
    nextCursor: cursorValue,
  }
}

/**
 * GET one notes page with bounded retry. Rate limits (429) and transient
 * upstream errors (5xx / network) back off (honoring Retry-After) and retry;
 * auth and other client errors (401/403/4xx) fail fast — retrying a bad key is
 * futile and just burns the window. Returns { notes: [] } when no key exists.
 */
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
  const url = `${GRANOLA_BASE_URL}/notes${qs ? `?${qs}` : ''}`

  let lastError = new Error('Granola API request failed')
  for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt += 1) {
    const result = await attemptNotesFetch(url, key.apiKey)
    if (result.ok) return result.page
    lastError = result.error
    if (!result.retryable || attempt >= MAX_FETCH_RETRIES) throw lastError
    await sleep(result.delayMs ?? backoffMs(attempt))
  }
  throw lastError
}

type FetchAttempt =
  | { ok: true; page: NotesPage }
  | { ok: false; retryable: boolean; error: Error; delayMs?: number }

async function attemptNotesFetch(url: string, apiKey: string): Promise<FetchAttempt> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
  } catch (error) {
    // Network/timeout — transient, worth a bounded retry.
    return { ok: false, retryable: true, error: error instanceof Error ? error : new Error(String(error)) }
  }
  if (response.ok) return { ok: true, page: parseNotesBody((await response.json()) as Record<string, unknown>) }
  // 429 / 5xx are retryable; everything else (esp. 401/403) is terminal.
  return {
    ok: false,
    retryable: response.status === 429 || response.status >= 500,
    error: new Error(`Granola API error ${response.status}`),
    delayMs: retryAfterMs(response.headers.get('retry-after')) ?? undefined,
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
      let pages = 0
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
        pages += 1
        // Cursor-loop guard: a bad API echoing the same cursor would otherwise
        // page forever. Dropping it ends the run cleanly.
        const nextCursor = page.nextCursor === pageCursor ? undefined : page.nextCursor
        // Always hand the cursor back on the batch (so the backfill runner
        // checkpoints it); the per-run page cap only stops THIS run's loop, and
        // a future run resumes from the checkpoint (dedupeKey makes overlap a
        // no-op).
        yield { events: page.notes.map((note) => granolaNoteActivity(note)), ...(nextCursor ? { nextCursor } : {}) }
        pageCursor = pages >= BACKFILL_MAX_PAGES ? undefined : nextCursor
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
          // Cursor-loop guard, matching backfill: a repeated cursor ends the run.
          pageCursor = page.nextCursor === pageCursor ? undefined : page.nextCursor
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
