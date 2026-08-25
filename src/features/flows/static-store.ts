import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { boundSeen, partitionUnseen, type UnseenPartition } from '@/lib/flows/static-data'

/**
 * The database half of flow static data.
 *
 * Keeps the I/O away from lib/flows/static-data.ts so the dedupe rule stays
 * pure and testable. Everything here is org-scoped: `flowId` alone would let a
 * crafted id reach another workspace's state, and the tenant guard exists to
 * make that impossible to forget.
 */

/** Reserved key for the cross-run dedupe set, so it cannot collide with a user key. */
export const SEEN_KEY = '__seen'

export async function readStaticData(
  organizationId: string,
  flowId: string,
  key: string,
): Promise<unknown> {
  const row = await prisma.flowStaticData.findFirst({
    where: { organizationId, flowId, key },
    select: { value: true },
  })
  return row?.value ?? undefined
}

export async function writeStaticData(
  organizationId: string,
  flowId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await prisma.flowStaticData.upsert({
    where: { organizationId_flowId_key: { organizationId, flowId, key } },
    create: { organizationId, flowId, key, value: value as Prisma.InputJsonValue },
    update: { value: value as Prisma.InputJsonValue },
  })
}

/** Every static-data key a flow holds, for the run panel and teardown. */
export async function listStaticData(organizationId: string, flowId: string) {
  return prisma.flowStaticData.findMany({
    where: { organizationId, flowId },
    orderBy: { key: 'asc' },
    select: { key: true, value: true, updatedAt: true },
  })
}

/**
 * Which of these items has this flow not seen before — and record them.
 *
 * Read, partition and write happen in ONE transaction with the row locked.
 * Without that, two runs of the same flow polling concurrently both read the
 * same seen-set, both conclude the same rows are new, and both act on them —
 * which is exactly the double-send that dedupe exists to prevent, and it only
 * shows up under the load where it hurts most.
 *
 * The lock is on the (flow, key) row, so it serialises only concurrent
 * dedupes of the SAME flow.
 */
export async function takeUnseen(
  organizationId: string,
  flowId: string,
  items: unknown[],
  idPath: string,
): Promise<UnseenPartition> {
  return prisma.$transaction(async (tx) => {
    // SELECT … FOR UPDATE via a raw statement: Prisma has no first-class row
    // lock, and an optimistic read here would reintroduce the race above.
    const locked = await tx.$queryRaw<Array<{ value: unknown }>>(
      Prisma.sql`SELECT "value" FROM "flow_static_data"
                 WHERE "flowId" = ${flowId} AND "organizationId" = ${organizationId}::uuid AND "key" = ${SEEN_KEY}
                 FOR UPDATE`,
    )

    const stored = locked[0]?.value
    const seen: string[] = Array.isArray(stored) ? (stored as string[]) : []
    const partition = partitionUnseen(items, idPath, seen)

    // Nothing new: leave the row alone rather than rewriting an identical
    // blob on every poll tick.
    if (partition.identities.length === 0) return partition

    const next = boundSeen([...seen, ...partition.identities])
    await tx.flowStaticData.upsert({
      where: { organizationId_flowId_key: { organizationId, flowId, key: SEEN_KEY } },
      create: { organizationId, flowId, key: SEEN_KEY, value: next as Prisma.InputJsonValue },
      update: { value: next as Prisma.InputJsonValue },
    })
    return partition
  })
}
