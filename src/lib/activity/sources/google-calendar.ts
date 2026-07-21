/**
 * Google Calendar ActivitySource — historical meetings through the native
 * Google proxy (NangoProxy-compatible; refresh tokens never leave
 * src/lib/google). connectionRef is the GoogleOAuthConnection id, which is
 * also the mirror NangoConnection's connectionId (provider 'google-native').
 *
 * Only MEETINGS THAT HAPPENED are ingested (timeMin..now): the ledger records
 * observed work patterns, not intentions. Attendee lists are capped and
 * event descriptions are never captured — same reference-only posture as the
 * rest of the ledger.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { googleProxy } from '@/lib/google/proxy'
import { GOOGLE_NATIVE_PROVIDER } from '@/lib/google/store'
import type { NangoProxy } from '@/lib/nango/delivery'
import {
  windowStart,
  type ActivitySource,
  type BackfillBatch,
  type BackfillWindow,
  type NormalizedActivity,
  type SourceContext,
} from '../types'

export const GOOGLE_CALENDAR_SOURCE = 'google_calendar'

const PAGE_SIZE = 250
const MAX_PARTICIPANTS = 20

type CalendarEvent = {
  id?: unknown
  status?: unknown
  summary?: unknown
  organizer?: { email?: unknown; displayName?: unknown }
  creator?: { email?: unknown }
  start?: { dateTime?: unknown; date?: unknown }
  end?: { dateTime?: unknown; date?: unknown }
  attendees?: Array<{ email?: unknown; resource?: unknown; responseStatus?: unknown }>
  recurringEventId?: unknown
}

function eventTime(value: { dateTime?: unknown; date?: unknown } | undefined): Date | null {
  const raw = typeof value?.dateTime === 'string' ? value.dateTime : typeof value?.date === 'string' ? value.date : null
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function googleCalendarActivity(item: CalendarEvent): NormalizedActivity | null {
  if (typeof item.id !== 'string' || item.status === 'cancelled') return null
  const start = eventTime(item.start)
  if (!start) return null
  const organizer = typeof item.organizer?.email === 'string' ? item.organizer.email : null
  const creator = typeof item.creator?.email === 'string' ? item.creator.email : null
  const actorRef = organizer ?? creator
  if (!actorRef) return null
  const attendees = (item.attendees ?? [])
    .filter((a) => typeof a.email === 'string' && a.resource !== true && a.responseStatus !== 'declined')
    .map((a) => a.email as string)
  const allDay = typeof item.start?.date === 'string' && typeof item.start?.dateTime !== 'string'
  return {
    source: GOOGLE_CALENDAR_SOURCE,
    actorRef,
    actorName: typeof item.organizer?.displayName === 'string' ? item.organizer.displayName : null,
    action: 'held_meeting',
    entityType: 'meeting',
    entityRef: item.id,
    entityName: typeof item.summary === 'string' ? item.summary.slice(0, 200) : null,
    participants: attendees.slice(0, MAX_PARTICIPANTS),
    businessContext: {
      attendeeCount: attendees.length,
      allDay,
      recurring: typeof item.recurringEventId === 'string',
    },
    occurredAt: start,
    dedupeKey: `gcal:event:${item.id}`,
  }
}

async function resolveConnection(ctx: SourceContext): Promise<{ connectionId: string } | null> {
  return prisma.nangoConnection.findFirst({
    where: { organizationId: ctx.organizationId, connectionId: ctx.connectionRef, provider: GOOGLE_NATIVE_PROVIDER },
    select: { connectionId: true },
  })
}

export function makeGoogleCalendarActivitySource(proxyOverride?: NangoProxy): ActivitySource {
  return {
    source: GOOGLE_CALENDAR_SOURCE,
    capabilities: { backfill: true, webhooks: false, incrementalSync: true },
    async *backfill(ctx: SourceContext, window: BackfillWindow, cursor?: string): AsyncIterable<BackfillBatch> {
      const connection = await resolveConnection(ctx)
      if (!connection) return
      const proxy = proxyOverride
        ?? googleProxy({ organizationId: ctx.organizationId, connectionId: connection.connectionId })
      const now = new Date()
      const since = windowStart(window, now)

      let pageToken = cursor
      do {
        let events: NormalizedActivity[] = []
        let nextToken: string | undefined
        try {
          const response = await proxy({
            method: 'GET',
            endpoint: '/calendar/v3/calendars/primary/events',
            connectionId: connection.connectionId,
            providerConfigKey: 'google-calendar',
            params: {
              maxResults: PAGE_SIZE,
              singleEvents: 'true',
              timeMax: now.toISOString(),
              ...(since ? { timeMin: since.toISOString() } : {}),
              ...(pageToken ? { pageToken } : {}),
            },
          })
          const data = response.data as { items?: unknown[]; nextPageToken?: unknown }
          const items = Array.isArray(data.items) ? (data.items as CalendarEvent[]) : []
          events = items
            .map((item) => googleCalendarActivity(item))
            .filter((event): event is NormalizedActivity => event !== null)
          nextToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined
        } catch (error) {
          // A revoked grant or transient API failure ends this backfill run;
          // the checkpointed cursor lets the next run resume where it stopped.
          apiLogger.warn('google-calendar backfill: page fetch failed, stopping run', {
            error: error instanceof Error ? error.message : String(error),
          })
          yield { events: [], ...(pageToken ? { nextCursor: pageToken } : {}) }
          return
        }
        pageToken = nextToken
        yield { events, ...(pageToken ? { nextCursor: pageToken } : {}) }
      } while (pageToken)
    },
    async handleEvent() {
      return []
    },
    // Daily freshness leg: meetings held since the last observed event, up to
    // two pages. Dedupe keys make overlap with prior runs a no-op.
    async incrementalSync(ctx: SourceContext, since: Date): Promise<NormalizedActivity[]> {
      const connection = await resolveConnection(ctx)
      if (!connection) return []
      const proxy = proxyOverride
        ?? googleProxy({ organizationId: ctx.organizationId, connectionId: connection.connectionId })
      const now = new Date()
      const events: NormalizedActivity[] = []
      let pageToken: string | undefined
      let pages = 0
      try {
        do {
          const response = await proxy({
            method: 'GET',
            endpoint: '/calendar/v3/calendars/primary/events',
            connectionId: connection.connectionId,
            providerConfigKey: 'google-calendar',
            params: {
              maxResults: PAGE_SIZE,
              singleEvents: 'true',
              timeMin: since.toISOString(),
              timeMax: now.toISOString(),
              ...(pageToken ? { pageToken } : {}),
            },
          })
          const data = response.data as { items?: unknown[]; nextPageToken?: unknown }
          const items = Array.isArray(data.items) ? (data.items as CalendarEvent[]) : []
          for (const item of items) {
            const event = googleCalendarActivity(item)
            if (event) events.push(event)
          }
          pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined
          pages += 1
        } while (pageToken && pages < 2)
      } catch (error) {
        apiLogger.warn('google-calendar incremental sync failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return events
    },
  }
}

export const googleCalendarActivitySource = makeGoogleCalendarActivitySource()
