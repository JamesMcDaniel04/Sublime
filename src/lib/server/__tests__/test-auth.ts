import crypto from 'node:crypto'
import { Plan, type UserRole } from '@/generated/prisma/client'
import { setTestAuthContext } from '../auth'
import type { AuthContext } from '../auth'

export type SeedOptions = {
  /**
   * Workspace role for the seeded user.
   *
   * Defaults to ADMIN because that is what production does: auth-utils.ts
   * provisions a user who arrives without an invitation as ADMIN, so "the user
   * of this workspace" IS its admin. A seeded MEMBER would be the unusual case.
   *
   * Tests asserting a REFUSAL must therefore pass 'MEMBER' explicitly — and
   * should, because a negative authorization test that silently ran as an admin
   * would pass for the wrong reason.
   */
  role?: UserRole
  /**
   * Effective plan. Defaults to ENTERPRISE so a plan gate never masks the role
   * behaviour a test is actually asserting; pass a lower plan to exercise
   * entitlement caps deliberately.
   */
  plan?: Plan
}

/** Seed an org + active user and return an AuthContext bound to them. */
export async function seedTestOrg(
  prisma: any,
  options: SeedOptions = {},
): Promise<{ organizationId: string; userId: string; auth: AuthContext; cleanup: () => Promise<void> }> {
  const role: UserRole = options.role ?? 'ADMIN'
  const plan: Plan = options.plan ?? Plan.ENTERPRISE
  const org = await prisma.organization.create({ data: { name: 'Smoke', slug: `smoke-${crypto.randomUUID()}`, plan } })
  const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true, role } })
  const auth: AuthContext = {
    organizationId: org.id,
    // Production semantics (requireAuthContext): auth.userId is the SUPABASE
    // id, distinct from dbUser.id. Routes that persist a user reference must
    // use dbUser.id — a seam that conflated the two hid exactly that bug.
    userId: user.supabaseId,
    dbUser: user,
    user: { id: user.supabaseId } as never,
    role,
    isAdmin: role === 'ADMIN',
    plan,
    actor: { userId: user.supabaseId, role, plan },
  }
  const cleanup = async () => {
    setTestAuthContext(null)
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
  }
  return { organizationId: org.id, userId: user.id, auth, cleanup }
}

/**
 * Fill an AuthContext from the identity fields a test actually cares about.
 *
 * Keeps tests from restating role/isAdmin/plan/actor every time those fields
 * change shape — the reason this helper exists is that adding them to
 * AuthContext broke every hand-built literal at once.
 */
export function makeTestAuthContext(
  partial: Pick<AuthContext, 'organizationId' | 'userId' | 'dbUser' | 'user'> & Partial<AuthContext>,
): AuthContext {
  const role: UserRole = partial.role ?? 'ADMIN'
  const plan: Plan = partial.plan ?? Plan.ENTERPRISE
  return {
    ...partial,
    role,
    isAdmin: partial.isAdmin ?? role === 'ADMIN',
    plan,
    actor: partial.actor ?? { userId: partial.userId, role, plan },
  }
}

export function installTestAuth(auth: AuthContext): void {
  setTestAuthContext(auth)
}
export function clearTestAuth(): void {
  setTestAuthContext(null)
}
