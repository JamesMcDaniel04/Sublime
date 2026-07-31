import { prisma } from '@/lib/prisma'

/**
 * Atomic key-level merge into organizations.settings.
 *
 * The previous pattern — read the blob, spread-merge in JS, write the whole
 * blob back — was a lost-update generator: any two writes interleaving between
 * read and write silently reverted each other's keys (two admins toggling
 * different switches; a member saving impact assumptions erasing a concurrent
 * zeroDataRetention enable; a settings save clobbering the jsonb_set throttle
 * claims the intelligence sweeps write). `||` merges at the key level inside
 * Postgres, so concurrent writers only collide when they touch the SAME key.
 *
 * Raw SQL keeps tenant scoping: the WHERE carries the org id from the caller's
 * auth context.
 */
export async function mergeOrgSettings(organizationId: string, patch: Record<string, unknown>): Promise<void> {
  if (Object.keys(patch).length === 0) return
  await prisma.$executeRaw`
    UPDATE "organizations"
    SET "settings" = COALESCE("settings", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
    WHERE "id" = ${organizationId}::uuid`
}

/** Atomically append a scan-exclusion entry (no-op when already present). */
export async function addScanExclusion(organizationId: string, entry: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "organizations"
    SET "settings" = jsonb_set(
      COALESCE("settings", '{}'::jsonb),
      '{scanExclusions}',
      COALESCE("settings"->'scanExclusions', '[]'::jsonb) || to_jsonb(${entry}::text),
      true
    )
    WHERE "id" = ${organizationId}::uuid
      AND NOT (COALESCE("settings"->'scanExclusions', '[]'::jsonb) @> to_jsonb(${entry}::text))`
}

/** Atomically remove a scan-exclusion entry. */
export async function removeScanExclusion(organizationId: string, entry: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "organizations"
    SET "settings" = jsonb_set(
      COALESCE("settings", '{}'::jsonb),
      '{scanExclusions}',
      COALESCE(
        (SELECT jsonb_agg(elem)
         FROM jsonb_array_elements(COALESCE("settings"->'scanExclusions', '[]'::jsonb)) AS elem
         WHERE elem <> to_jsonb(${entry}::text)),
        '[]'::jsonb
      ),
      true
    )
    WHERE "id" = ${organizationId}::uuid`
}
