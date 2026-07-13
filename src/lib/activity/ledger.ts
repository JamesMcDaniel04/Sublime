/**
 * Durable activity ledger writes. Dedup is the DB unique constraint
 * (organizationId, dedupeKey) caught as P2002 — a replayed webhook or an
 * overlapping backfill page cannot double-write (same mechanism as Signal).
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { IngestKind, NormalizedActivity } from './types'

/** Injectable seam for tests; production callers omit it. */
export type ActivityDb = Pick<typeof prisma, 'activityEvent'>

export interface PersistedActivity extends NormalizedActivity {
  id: string
  organizationId: string
  ingestKind: IngestKind
}

function isUniqueViolation(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') ||
    (error instanceof Error && (error as { code?: string }).code === 'P2002')
  )
}

export async function persistActivity(
  organizationId: string,
  ingestKind: IngestKind,
  events: NormalizedActivity[],
  db: ActivityDb = prisma,
): Promise<{ created: PersistedActivity[]; duplicates: number }> {
  const created: PersistedActivity[] = []
  let duplicates = 0
  for (const event of events) {
    try {
      const row = await db.activityEvent.create({
        data: {
          organizationId,
          ingestKind,
          source: event.source,
          actorRef: event.actorRef,
          actorName: event.actorName ?? null,
          action: event.action,
          entityType: event.entityType,
          entityRef: event.entityRef,
          entityName: event.entityName ?? null,
          previousState: (event.previousState ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          newState: (event.newState ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          participants: (event.participants ?? []) as Prisma.InputJsonValue,
          businessContext: (event.businessContext ?? {}) as Prisma.InputJsonValue,
          outcome: event.outcome ?? null,
          occurredAt: event.occurredAt,
          dedupeKey: event.dedupeKey,
        },
      })
      created.push({ ...event, id: row.id, organizationId, ingestKind })
    } catch (error) {
      if (isUniqueViolation(error)) { duplicates++; continue }
      throw error
    }
  }
  return { created, duplicates }
}
