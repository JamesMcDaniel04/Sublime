import { getAuthWithUser } from '@/lib/supabase/auth-utils'

type AuthResult = NonNullable<Awaited<ReturnType<typeof getAuthWithUser>>>

export interface AuthContext {
  user: AuthResult['user']
  dbUser: NonNullable<AuthResult['dbUser']>
  userId: string
  organizationId: string
}

// Production-inert test seam: mirrors src/lib/observability/sentry.ts's
// injectable reporter. A route smoke test injects a seeded auth context so it
// can drive real handlers without a Supabase session. NEVER active in
// production — double-gated on NODE_ENV and TEST_DATABASE_URL (production sets
// neither), and null by default so real auth runs unless a test injects.
let testAuthContext: AuthContext | null = null

export function setTestAuthContext(ctx: AuthContext | null): void {
  testAuthContext = ctx
}

function testAuthActive(): boolean {
  return process.env.NODE_ENV !== 'production' && Boolean(process.env.TEST_DATABASE_URL)
}

export class AuthContextError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
    readonly code: string = 'AUTH_ERROR',
  ) {
    super(message)
    this.name = 'AuthContextError'
  }
}

export async function requireAuthContext(): Promise<AuthContext> {
  if (testAuthContext && testAuthActive()) return testAuthContext

  const auth = await getAuthWithUser()

  if (!auth?.user || !auth.userId) {
    throw new AuthContextError('Authentication required', 401)
  }

  if (!auth.dbUser || !auth.organizationId) {
    throw new AuthContextError('Organization access required', 403)
  }

  return {
    user: auth.user,
    dbUser: auth.dbUser,
    userId: auth.userId,
    organizationId: auth.organizationId,
  }
}
