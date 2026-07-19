import type { User } from '@supabase/supabase-js'
import { prisma, systemPrisma } from '@/lib/prisma'
import { createClient } from '@/lib/supabase/server'
import { isLegacyPlatformUser } from '@/lib/billing/entitlements'

// An auth identity resolves to a user either directly (users.supabaseId, the
// first identity) or via a linked user_identities row (any later sign-in
// method for the same verified email).
function findDbUser(supabaseId: string) {
  return prisma.user.findFirst({
    where: { isActive: true, OR: [{ supabaseId }, { identities: { some: { supabaseId } } }] },
    include: { organization: true },
  })
}

/**
 * Only a VERIFIED email may link a new auth identity to an existing user —
 * otherwise an unconfirmed password signup with someone else's address would
 * inherit their whole workspace. OAuth providers assert it via
 * user_metadata.email_verified; confirmed email signups carry
 * email_confirmed_at.
 */
function emailVerified(user: User): boolean {
  const meta = (user.user_metadata || {}) as Record<string, unknown>
  if (meta.email_verified === true) return true
  return Boolean((user as { email_confirmed_at?: string | null }).email_confirmed_at)
}

// Per-instance cache of the supabaseId → app user (+org) lookup. This query
// runs on EVERY authenticated API request via requireAuthContext; the row
// changes rarely (role/org edits), so a short TTL removes a DB round-trip from
// the hot path on warm instances while bounding staleness to one minute.
type DbUserRow = Awaited<ReturnType<typeof findDbUser>>
const DB_USER_TTL_MS = 60_000
const dbUserCache = new Map<string, { row: NonNullable<DbUserRow>; ts: number }>()

async function findDbUserCached(supabaseId: string): Promise<DbUserRow> {
  const hit = dbUserCache.get(supabaseId)
  if (hit && Date.now() - hit.ts < DB_USER_TTL_MS) return hit.row
  const row = await findDbUser(supabaseId)
  if (row) dbUserCache.set(supabaseId, { row, ts: Date.now() })
  else dbUserCache.delete(supabaseId)
  return row
}

/**
 * Drop the cached user→workspace row after a membership-changing mutation
 * (workspace delete, account delete) so the next request re-resolves instead
 * of serving a dead organization for up to the cache TTL.
 */
export function invalidateDbUserCache(supabaseId: string): void {
  dbUserCache.delete(supabaseId)
}

// Workspace bootstrap: every Supabase identity gets its OWN workspace on
// first signup (as its admin) — a user's agents, flows, and runs are private
// to their workspace by default. A pending invitation wins: the invitee joins
// the inviting workspace (their team) with the invited role instead.
export async function provisionUser(user: User, existing?: NonNullable<DbUserRow>) {
  const normalizedEmail = user.email?.trim().toLowerCase()
  const meta = (user.user_metadata || {}) as Record<string, unknown>
  const emailPrefix = (user.email || 'user').split('@')[0]
  const metaString = (key: string) => (typeof meta[key] === 'string' ? (meta[key] as string) : '')
  const orgName = metaString('organization_name') || metaString('full_name') || emailPrefix
  const name = metaString('full_name') || emailPrefix

  try {
    // systemPrisma: workspace bootstrap runs BEFORE the user has any tenant
    // context — the invitation lookup is cross-org by design (which workspace
    // invited this email?), so the tenant guard cannot apply here.
    return await systemPrisma.$transaction(async (tx) => {
      // Serialize concurrent first requests from the same new session so one
      // identity never creates two workspaces. Transaction-scoped, auto-releases.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`

      // Another API request from the same freshly signed-in browser may have
      // completed provisioning while this one waited for the lock. Honor that
      // membership instead of re-provisioning it.
      const current = existing ?? await tx.user.findFirst({
        where: { isActive: true, OR: [{ supabaseId: user.id }, { identities: { some: { supabaseId: user.id } } }] },
        include: { organization: true },
      })
      if (current?.organizationId) return current

      // Same person, different sign-in method: an active user already exists
      // for this VERIFIED email under another Supabase identity. Link this
      // identity to that user instead of minting a duplicate user + workspace
      // — otherwise their flows/agents split across two "selves" per auth
      // method. Unverified emails never link (workspace-takeover vector).
      if (!current && normalizedEmail && emailVerified(user)) {
        const sameEmail = await tx.user.findFirst({
          where: { email: normalizedEmail, isActive: true, supabaseId: { not: user.id }, organizationId: { not: null } },
          orderBy: { createdAt: 'asc' },
          include: { organization: true },
        })
        if (sameEmail) {
          const provider = (user.app_metadata as Record<string, unknown> | undefined)?.provider
          await tx.userIdentity.create({
            data: { supabaseId: user.id, userId: sameEmail.id, provider: typeof provider === 'string' ? provider : null },
          })
          return sameEmail
        }
      }

      const invitation = normalizedEmail
        ? await tx.organizationInvitation.findFirst({
            where: { email: normalizedEmail, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
          })
        : null

      // Invited → join the inviting team. Otherwise → a fresh personal
      // workspace, owned (ADMIN) by this user. Nobody is ever folded into an
      // unrelated existing workspace implicitly.
      const organization = invitation
        ? { id: invitation.organizationId }
        : await tx.organization.create({
            data: { name: orgName, slug: `org-${user.id}` },
          })
      const role = invitation?.role ?? 'ADMIN'

      const member = current
        ? await tx.user.update({
            where: { id: current.id },
            data: { organizationId: organization.id, role, email: normalizedEmail ?? current.email, name },
            include: { organization: true },
          })
        : await tx.user.create({
            data: { supabaseId: user.id, email: normalizedEmail, name, role, organizationId: organization.id },
            include: { organization: true },
          })

      if (invitation) {
        await tx.organizationInvitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } })
      }
      return member
    })
  } catch (error) {
    // A concurrent request may have created the membership while this one was
    // waiting. Re-read that winner, but never hide a real database failure as
    // a misleading "Organization access required" response.
    const winner = await findDbUser(user.id)
    if (winner?.organizationId) return winner
    throw error
  }
}

// The identity provider owns the email address — a change (with its double
// confirmation) happens entirely between the browser and Supabase, so the
// only place the app learns about it is the token on the next request.
// Mirror a confirmed new address onto the app row before handing it out;
// a token without an email claim never clears a stored address.
async function syncAuthEmail(user: User, existing: NonNullable<DbUserRow>): Promise<NonNullable<DbUserRow>> {
  const email = user.email?.trim().toLowerCase()
  if (!email || email === existing.email) return existing
  const updated = await prisma.user.update({
    where: { id: existing.id },
    data: { email },
    include: { organization: true },
  })
  dbUserCache.set(user.id, { row: updated, ts: Date.now() })
  return updated
}

export async function ensureWorkspaceMembership(user: User): Promise<DbUserRow> {
  const existing = await findDbUserCached(user.id)
  if (existing?.organizationId) return syncAuthEmail(user, existing)

  const provisioned = await provisionUser(user, existing ?? undefined)
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

  const resolvedDbUser = await ensureWorkspaceMembership(user)
  // Every account that existed before paid-from-day-one is an unrestricted
  // internal/test account. Normalize its role at the auth boundary so every
  // admin-only surface (settings, integrations, flows, members) agrees even
  // when a deployment missed the one-time role backfill.
  const dbUser = resolvedDbUser && isLegacyPlatformUser(resolvedDbUser)
    ? { ...resolvedDbUser, role: 'ADMIN' as const }
    : resolvedDbUser

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
