import { PrismaClient } from '@/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { poolConfigFromDatabaseUrl } from '@/lib/prisma-pool'
import { assertOrgScoped } from '@/lib/tenant-guard'

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createGuardedClient>
  systemPrisma?: PrismaClient
}

function createPrismaClient() {
  // Prisma 7 requires an explicit driver adapter; the client no longer reads
  // the datasource from the schema. Same pooled DATABASE_URL as before —
  // sslmode etc. stay in the connection string, interpreted by node-postgres.
  // The getter defers env resolution to the first query (when the adapter
  // builds its pg.Pool), preserving v6's lazy-connect timing that the
  // DB-gated test suites rely on (they assign DATABASE_URL after import).
  return new PrismaClient({
    adapter: new PrismaPg({
      get connectionString() {
        return process.env.DATABASE_URL
      },
      // Prisma 7 handed pooling to node-postgres, which does not understand
      // the URL's `connection_limit` — so every process silently took the
      // driver default of 10 while env.ts went on asserting the configured
      // value. A getter, like connectionString above, so it resolves at the
      // same (lazy) moment. See lib/prisma-pool.ts.
      get max() {
        return poolConfigFromDatabaseUrl(process.env.DATABASE_URL).max
      },
    }),
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })
}

function createGuardedClient(base: PrismaClient) {
  // Tenant guard: org-carrying models must be queried with organizationId.
  // See src/lib/tenant-guard.ts. System-wide paths use systemPrisma below.
  return base.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          assertOrgScoped(model, operation, args)
          return query(args)
        },
      },
    },
  })
}

/**
 * Unguarded client for enumerated system paths ONLY (cron sweeps, reapers,
 * tenant resolution, auth bootstrap, worker-internal id-keyed writes). Every
 * call site carries a one-line justification comment. User-facing code uses
 * `prisma`.
 */
export const systemPrisma = globalForPrisma.systemPrisma ?? createPrismaClient()
globalForPrisma.systemPrisma = systemPrisma

export const prisma = globalForPrisma.prisma ?? createGuardedClient(systemPrisma)
// Cache in all environments: on Vercel this reuses one client (and its pool)
// across warm serverless invocations. The guarded client wraps the SAME
// underlying connection pool as systemPrisma — one pool, two lenses.
globalForPrisma.prisma = prisma
