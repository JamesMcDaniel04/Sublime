import crypto from 'node:crypto'
import { setTestAuthContext } from '../auth'
import type { AuthContext } from '../auth'

/** Seed an org + active user and return an AuthContext bound to them. */
export async function seedTestOrg(prisma: any): Promise<{ organizationId: string; userId: string; auth: AuthContext; cleanup: () => Promise<void> }> {
  const org = await prisma.organization.create({ data: { name: 'Smoke', slug: `smoke-${crypto.randomUUID()}` } })
  const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true } })
  const auth: AuthContext = {
    organizationId: org.id,
    // Production semantics (requireAuthContext): auth.userId is the SUPABASE
    // id, distinct from dbUser.id. Routes that persist a user reference must
    // use dbUser.id — a seam that conflated the two hid exactly that bug.
    userId: user.supabaseId,
    dbUser: user,
    user: { id: user.supabaseId } as never,
  }
  const cleanup = async () => {
    setTestAuthContext(null)
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
  }
  return { organizationId: org.id, userId: user.id, auth, cleanup }
}

export function installTestAuth(auth: AuthContext): void {
  setTestAuthContext(auth)
}
export function clearTestAuth(): void {
  setTestAuthContext(null)
}
