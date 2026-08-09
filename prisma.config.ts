// Prisma 7 CLI configuration. The runtime client does NOT read this file —
// it connects through the pg driver adapter in src/lib/prisma.ts. This config
// feeds the CLI only (migrate deploy/resolve/dev, db push, studio).
//
// Prisma 7 stopped auto-loading .env for the CLI, so load one if present
// (no-op on Vercel/Fly, where env comes from the platform; this repo keeps
// no local .env — see .env.example).
try {
  process.loadEnvFile()
} catch {
  // No .env file — env vars come from the shell / platform.
}

import { defineConfig } from 'prisma/config'

// Migrations need a migration-capable (non-transaction-pooled) connection.
// That was `directUrl` in the v6 schema; the v7 config has a single CLI url,
// so prefer DIRECT_URL and fall back to DATABASE_URL (local throwaway
// Postgres, CI). Resolved lazily-enough: commands that need no URL (e.g.
// `prisma generate`, `prisma validate`) work even with neither set.
const cliUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: cliUrl,
  },
})
