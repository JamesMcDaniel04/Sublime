// Applies pending Prisma migrations during the build — but ONLY on production
// deploys (VERCEL_ENV=production). Preview builds and local `npm run build` skip
// it, so a branch's new migration never touches the prod DB before it merges.
//
// Requires DIRECT_URL to reach a migration-capable connection. On Supabase +
// Vercel that MUST be the session pooler (aws-<n>-<region>.pooler.supabase.com
// :5432, IPv4) — the direct db.<ref>.supabase.co host is IPv6-only and
// unreachable from Vercel's build runners.
import { execSync } from 'node:child_process'

const env = process.env.VERCEL_ENV ?? 'local'
const RECOVERABLE_FAILED_MIGRATIONS = [
  // The first production attempt used an invalid UPDATE ... FROM LATERAL
  // reference. The checked-in replacement is idempotent, so a failed record
  // for this exact migration can be rolled back and safely retried.
  '20260713120000_personal_workspace_boundaries',
]

function deployMigrations() {
  execSync('prisma migrate deploy', { stdio: 'inherit' })
}

if (env === 'production') {
  console.log('▸ production deploy — applying migrations (prisma migrate deploy)')
  try {
    deployMigrations()
  } catch (firstError) {
    // `migrate resolve --rolled-back` succeeds only when this exact migration
    // has a failed record. If the deploy failed for any other reason, resolve
    // also fails and the build remains stopped rather than masking the error.
    for (const migration of RECOVERABLE_FAILED_MIGRATIONS) {
      console.warn(`▸ checking known failed migration recovery: ${migration}`)
      execSync(`prisma migrate resolve --rolled-back ${migration}`, { stdio: 'inherit' })
    }
    console.log('▸ retrying migrations after failed-record recovery')
    deployMigrations()
    void firstError
  }
} else {
  console.log(`▸ skipping migrations (VERCEL_ENV=${env})`)
}
