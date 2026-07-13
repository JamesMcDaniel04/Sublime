import type { User } from '@supabase/supabase-js'
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

async function findDbUserCached(supabaseId: string): Promise<DbUserRow> {
  const hit = dbUserCache.get(supabaseId)
  if (hit && Date.now() - hit.ts < DB_USER_TTL_MS) return hit.row
  const row = await findDbUser(supabaseId)
  if (row) dbUserCache.set(supabaseId, { row, ts: Date.now() })
  else dbUserCache.delete(supabaseId)
  return row
}

// Self-healing bootstrap: every accepted Supabase identity joins the original
// workspace. The first-ever identity bootstraps that workspace; all later
// signups are regular members. Pending invitations still win.
async function provisionUser(user: User, existing?: NonNullable<DbUserRow>) {
  const normalizedEmail = user.email?.trim().toLowerCase()
  const meta = (user.user_metadata || {}) as Record<string, unknown>
  const emailPrefix = (user.email || 'user').split('@')[0]
  const metaString = (key: string) => (typeof meta[key] === 'string' ? (meta[key] as string) : '')
  const orgName = metaString('organization_name') || metaString('full_name') || emailPrefix
  const name = metaString('full_name') || emailPrefix

  try {
    return await prisma.$transaction(async (tx) => {
      // Serialize first-workspace creation and concurrent first requests from
      // the same new session. This is transaction-scoped and auto-releases.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(73194521)`

      const invitation = normalizedEmail
        ? await tx.organizationInvitation.findFirst({
            where: { email: normalizedEmail, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
          })
        : null

      // The oldest active-admin workspace is the original platform workspace.
      // This avoids another deployment setting and deterministically ignores
      // any accidental per-signup workspaces created by the reverted build.
      const primary = invitation
        ? null
        : await tx.organization.findFirst({
            where: { users: { some: { isActive: true, role: 'ADMIN' } } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })

      const organization = invitation
        ? { id: invitation.organizationId }
        : primary ?? await tx.organization.create({
            data: { name: orgName, slug: `org-${user.id}` },
          })
      const role = invitation?.role
        ?? (!primary ? 'ADMIN' : existing?.organizationId === organization.id ? existing.role : 'USER')

      const member = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: { organizationId: organization.id, role, email: normalizedEmail ?? existing.email, name },
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

function needsPrimaryWorkspace(row: NonNullable<DbUserRow>, supabaseId: string): boolean {
  return !row.organizationId || row.organization?.slug === `org-${supabaseId}`
}

async function ensureWorkspaceMembership(user: User): Promise<DbUserRow> {
  const existing = await findDbUserCached(user.id)
  if (existing && !needsPrimaryWorkspace(existing, user.id)) return existing

  // A sole first user legitimately owns the oldest workspace; provisionUser
  // will select that same organization and leave them as its admin. Users in
  // accidental per-signup orgs are moved into the older primary workspace.
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

  const dbUser = await ensureWorkspaceMembership(user)

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
