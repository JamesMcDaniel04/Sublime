/**
 * Structural guarantee: a member cannot read another member's directory data.
 *
 * The workspace rule is that only ADMINS see other people's details — email,
 * role, activity, pending invitations. Everyone else gets what a collaborative
 * feature actually needs: an id and something to print.
 *
 * Two ways that rule erodes, both of which happened here and both of which this
 * test now catches:
 *
 *   1. A new route selects `email` from the user model and declares only
 *      'member', because listing teammates felt harmless. GET
 *      /api/settings/members did exactly this and returned every colleague's
 *      email, role, lastSeenAt and the pending-invitation list to anyone.
 *
 *   2. A route writes `user.name || user.email` as a display fallback. It reads
 *      as a nicety and silently emits a full address for every account that has
 *      not set a name. Four routes had it independently.
 *
 * Reads source, so it runs in the plain unit pass with no database.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const API_DIR = fileURLToPath(new URL('..', import.meta.url))

/** Capabilities reserved to workspace admins — mirrors ADMIN_ONLY in permissions.ts. */
const ADMIN_CAPABILITIES = [
  'goal:create:org',
  'insights:workspace',
  'member:manage',
  'billing:manage',
  'resource:takeover',
  'settings:workspace',
  'goal:restrict',
]

/**
 * Routes that read `email` while declaring only 'member'. Each must say why —
 * adding an entry should be a deliberate, reviewed act, which is what the
 * required prose is for.
 */
const REVIEWED_MEMBER_LEVEL_READS: ReadonlyArray<{ route: string; reason: string }> = [
  {
    route: 'settings/profile',
    reason: "the caller's OWN profile; no other user's row is read",
  },
  {
    route: 'organizations/members',
    reason: 'people picker: email is included only when auth.isAdmin, otherwise id + display name',
  },
  {
    route: 'flows/[id]/comments',
    reason: 'comment author byline via memberDisplayName; the raw address never reaches the response',
  },
  {
    route: 'credentials',
    reason: 'credential owner byline via memberDisplayName; the raw address never reaches the response',
  },
  {
    route: 'goals/[id]/work',
    reason: 'assignee labels via memberDisplayName; email is read only to build the display map',
  },
]

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name === 'route.ts') out.push(full)
  }
  return out
}

const routeFiles = walk(API_DIR).map((file) => ({
  route: path.relative(API_DIR, path.dirname(file)),
  source: readFileSync(file, 'utf8'),
}))

test('a route reading user email is admin-gated or reviewed', () => {
  const reviewed = new Set(REVIEWED_MEMBER_LEVEL_READS.map((entry) => entry.route))

  const offenders = routeFiles
    .filter(({ source }) => /email:\s*true/.test(source))
    .filter(({ route, source }) => {
      if (reviewed.has(route)) return false
      const declared = source.match(/requires:\s*'([^']+)'/g) ?? []
      // Admin-gated when EVERY declaration on the route is an admin capability:
      // one 'member' handler beside an admin one still exposes the read.
      return !(declared.length > 0 && declared.every((d) => ADMIN_CAPABILITIES.some((cap) => d.includes(cap))))
    })
    .map(({ route }) => route)
    .sort()

  assert.deepEqual(
    offenders,
    [],
    `Route(s) reading user email without an admin capability: ${offenders.join(', ')}. `
      + 'Gate it behind an admin capability, or add it to REVIEWED_MEMBER_LEVEL_READS with the reason '
      + 'the read is safe (typically: it never reaches the response body).',
  )
})

test('the reviewed list has no stale entries', () => {
  // A deleted or converted route left on the list would silently widen the
  // exemption for whatever later takes its path.
  const present = new Set(routeFiles.map(({ route }) => route))
  const stale = REVIEWED_MEMBER_LEVEL_READS.filter((entry) => !present.has(entry.route)).map((e) => e.route)
  assert.deepEqual(stale, [], `Reviewed route(s) no longer exist: ${stale.join(', ')}`)
})

test('every reviewed entry states a reason', () => {
  const unexplained = REVIEWED_MEMBER_LEVEL_READS.filter((entry) => entry.reason.trim().length < 20).map((e) => e.route)
  assert.deepEqual(unexplained, [], `Reviewed entries needing a real reason: ${unexplained.join(', ')}`)
})

test('no route builds a display name out of an email address', () => {
  // `user.name || user.email` emits a full address for every account with no
  // display name set. memberDisplayName() exists so there is one answer to this
  // and it is the local part, not the address.
  const pattern = /\.name\s*(\|\||\?\?)\s*[\w.]*\.email/
  const offenders = routeFiles
    .filter(({ source }) => pattern.test(source))
    .map(({ route }) => route)
    .sort()

  assert.deepEqual(
    offenders,
    [],
    `Route(s) using an email as a display-name fallback: ${offenders.join(', ')}. `
      + 'Use memberDisplayName() from @/lib/server/member-display.',
  )
})
