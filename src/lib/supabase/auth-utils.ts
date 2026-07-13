import type { User } from '@supabase/supabase-js'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createClient } from '@/lib/supabase/server'

function findDbUser(supabaseId: string) {
  return prisma.user.findFirst({
    where: { supabaseId, isActive: true },
    include: { organization: true },
  })
}

// Per-instance cache of the supabaseId → app user (+org) lookup. This query
// runs on EVERY authenticated API request via requireAuthContext; the row
// changes rarely (role/org edits), so a short TTL removes a DB round-trip from
// the hot path on warm instances while bounding staleness to one minute.
type DbUserRow = Awaited<ReturnType<typeof findDbUser>>
const DB_USER_TTL_MS = 60_000
const dbUserCache = new Map<string, { row: NonNullable<DbUserRow>; ts: number }>()

/** Settings/member writes call this so role, suspension, and deletion changes
 * take effect immediately instead of waiting for the one-minute auth TTL. */
export function invalidateDbUserCache(supabaseId: string): void {
  dbUserCache.delete(supabaseId)
}

async function findDbUserCached(supabaseId: string): Promise<DbUserRow> {
  const hit = dbUserCache.get(supabaseId)
  if (hit && Date.now() - hit.ts < DB_USER_TTL_MS) return hit.row
  const row = await findDbUser(supabaseId)
  if (row) dbUserCache.set(supabaseId, { row, ts: Date.now() })
  else dbUserCache.delete(supabaseId)
  return row
}

// Self-healing bootstrap: the handle_new_user Postgres trigger is optional
// infra that may never be installed, so provision the app user + organization
// on first authenticated request when they don't exist yet.
export async function provisionUser(user: User) {
  const normalizedEmail = user.email?.trim().toLowerCase()
  if (normalizedEmail) {
    const invitation = await prisma.organizationInvitation.findFirst({
      where: { email: normalizedEmail, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    })
    if (invitation) {
      return prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { supabaseId: user.id, email: normalizedEmail, name: String(user.user_metadata?.full_name || normalizedEmail.split('@')[0]), role: invitation.role, organizationId: invitation.organizationId },
          include: { organization: true },
        })
        await tx.organizationInvitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } })
        return created
      })
    }
  }
  // Every authenticated identity must have a workspace. Password signup can
  // still be disabled at the auth boundary, but once Supabase has accepted an
  // identity we must never leave it in an authenticated-without-an-org limbo.
  // Pending invitations win above; all other users own a new workspace.
  const meta = (user.user_metadata || {}) as Record<string, unknown>
  const emailPrefix = (user.email || 'user').split('@')[0]
  const metaString = (key: string) => (typeof meta[key] === 'string' ? (meta[key] as string) : '')
  const orgName = metaString('organization_name') || metaString('full_name') || emailPrefix
  const name = metaString('full_name') || emailPrefix

  try {
    return await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { name: orgName, slug: `org-${user.id}` },
      })
      return tx.user.create({
        data: {
          supabaseId: user.id,
          email: user.email ?? null,
          name,
          role: 'ADMIN',
          organizationId: organization.id,
        },
        include: { organization: true },
      })
    })
  } catch (error) {
    // Lost a race (unique supabaseId/slug) or the trigger created it
    // concurrently. Do not turn unrelated database failures into a misleading
    // 403 "Organization access required" response.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error
    }
    const winner = await findDbUser(user.id)
    if (!winner) throw error
    return winner
  }
}

/** Resolve an existing active app user or atomically create their workspace.
 * Shared by the auth callback and every authenticated API request so signup,
 * password login, magic links, and invitation acceptance all converge on the
 * same provisioning invariant. */
export async function ensureAppUser(user: User): Promise<DbUserRow> {
  const existing = await findDbUserCached(user.id)
  if (existing) return existing

  const provisioned = await provisionUser(user)
  if (provisioned) dbUserCache.set(user.id, { row: provisioned, ts: Date.now() })
  return provisioned
}

export async function getAuthWithUser() {
  const supabase = await createClient()

  // Prefer getClaims(): on projects with asymmetric JWT signing keys the token
  // verifies LOCALLY against a cached JWKS — zero network on the auth hot path.
  // On legacy symmetric-key projects supabase-js falls back to a server check
  // itself, so behavior (and cost) is never worse than getUser(). Consumers
  // only use identity fields (id/email/user_metadata), all present in claims.
  let user: User | null = null
  try {
    const { data } = await supabase.auth.getClaims()
    const claims = data?.claims
    if (claims?.sub) {
      user = {
        id: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        user_metadata: (claims.user_metadata as Record<string, unknown> | undefined) ?? {},
        app_metadata: (claims.app_metadata as Record<string, unknown> | undefined) ?? {},
        aud: typeof claims.aud === 'string' ? claims.aud : 'authenticated',
        created_at: '',
      } as User
    }
  } catch {
    // Fall through to getUser below (e.g. token needs a refresh round-trip).
  }

  if (!user) {
    const { data, error } = await supabase.auth.getUser()
    if (error || !data.user) return null
    user = data.user
  }

  let dbUser = await ensureAppUser(user)

  // Supabase applies email changes only after its confirmation flow. Once the
  // confirmed address appears in the authenticated claims, mirror it into the
  // application row so profile/member reads do not revert to a stale address.
  const confirmedEmail = user.email?.trim().toLowerCase()
  if (dbUser?.organizationId && confirmedEmail && dbUser.email?.toLowerCase() !== confirmedEmail) {
    dbUser = await prisma.user.update({
      where: { id: dbUser.id, organizationId: dbUser.organizationId },
      data: { email: confirmedEmail },
      include: { organization: true },
    })
    dbUserCache.set(user.id, { row: dbUser, ts: Date.now() })
  }

  return {
    user,
    userId: user.id,
    dbUser,
    organizationId: dbUser?.organizationId ?? null,
  }
}

export async function requireAuth() {
  const auth = await getAuthWithUser()
  return auth?.dbUser ? auth : null
}
