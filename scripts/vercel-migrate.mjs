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
if (env === 'production') {
  // Branch enforcement is opt-in: set PRODUCTION_DEPLOY_BRANCH in Vercel to pin
  // prod deploys (and their migrations) to one branch. Unset, any promoted
  // preview build may deploy — the promotion itself is the human gate.
  const branch = process.env.VERCEL_GIT_COMMIT_REF
  const requiredBranch = process.env.PRODUCTION_DEPLOY_BRANCH
  if (requiredBranch && branch !== requiredBranch) {
    throw new Error(
      `Refusing a production deployment from ${branch || 'an unknown branch'}; PRODUCTION_DEPLOY_BRANCH pins production deployments to ${requiredBranch}.`,
    )
  }
  console.log(`▸ production deploy from ${branch || 'an unknown branch'} @ ${process.env.VERCEL_GIT_COMMIT_SHA || 'unknown commit'}`)
  // A 2026-08-02 deploy partially entered this migration before Supabase's
  // locked realtime schema rejected its policy DDL. The migration is now
  // idempotent and handles that role boundary, so clear only this known failed
  // attempt before the normal deploy. On databases where it is pending or
  // already applied Prisma refuses the resolve command and we continue.
  try {
    execSync('prisma migrate resolve --rolled-back 20260731180000_run_events_private_realtime', { stdio: 'pipe' })
    console.log('▸ recovered failed run-events Realtime migration for a clean retry')
  } catch {
    // Not in a failed state — the common path for fresh/already-migrated DBs.
  }
  console.log('▸ production deploy — applying migrations (prisma migrate deploy)')
  execSync('prisma migrate deploy', { stdio: 'inherit' })
} else {
  console.log(`▸ skipping migrations (VERCEL_ENV=${env})`)
}
