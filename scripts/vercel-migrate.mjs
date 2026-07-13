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
  console.log('▸ production deploy — applying migrations (prisma migrate deploy)')
  execSync('prisma migrate deploy', { stdio: 'inherit' })
} else {
  console.log(`▸ skipping migrations (VERCEL_ENV=${env})`)
}
