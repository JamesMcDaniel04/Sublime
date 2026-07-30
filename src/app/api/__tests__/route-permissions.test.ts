/**
 * Structural guarantee: EVERY API route has consciously decided who may call it.
 *
 * A route either goes through withAuthenticatedApi (and therefore declares
 * `requires`, which TypeScript makes mandatory), or it authenticates by some
 * other mechanism and is listed below with that mechanism named.
 *
 * This is the test that makes the permission core hardening rather than merely
 * more checks: a 14th differently-authenticated route, or a hand-rolled
 * session route that quietly skips authorization, fails CI instead of shipping.
 *
 * No database required — it reads source, so it runs in the plain unit pass.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CAPABILITIES } from '@/lib/server/permissions'

const API_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * Routes that legitimately do NOT use withAuthenticatedApi. Each authenticates
 * by another mechanism — none is drift. Adding to this list should be a
 * deliberate, reviewed act, which is why the reason is required text.
 */
const DIFFERENTLY_AUTHENTICATED: ReadonlyArray<{ route: string; mechanism: string }> = [
  { route: 'stripe/webhook', mechanism: 'Stripe webhook signature' },
  { route: 'stripe/portal', mechanism: 'session + canManageBillingByRole; plan-exempt so a locked-out workspace can still pay' },
  { route: 'stripe/topup', mechanism: 'session + canManageBillingByRole; plan-exempt so a locked-out workspace can still pay' },
  { route: 'stripe/checkout', mechanism: 'session + canManageBillingByRole; plan-exempt so a locked-out workspace can still pay' },
  { route: 'cron/retention', mechanism: 'cron shared secret' },
  { route: 'cron/dispatch', mechanism: 'cron shared secret' },
  { route: 'flows/[id]/trigger', mechanism: 'per-flow trigger token' },
  { route: 'agents/[id]/trigger', mechanism: 'per-agent trigger token' },
  { route: 'mcp-connections/oauth/callback', mechanism: 'OAuth state parameter' },
  { route: 'google/oauth/callback', mechanism: 'OAuth state parameter' },
  { route: 'slack/events/[bindingId]', mechanism: 'Slack request signature' },
  { route: 'system/behavior', mechanism: 'internal system endpoint' },
  { route: 'health', mechanism: 'public liveness probe' },
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

test('every route either declares a capability or is a listed differently-authenticated route', () => {
  const exempt = new Set(DIFFERENTLY_AUTHENTICATED.map((entry) => entry.route))
  const undeclared = routeFiles
    .filter(({ route, source }) => !exempt.has(route) && !source.includes('withAuthenticatedApi'))
    .map(({ route }) => route)
    .sort()

  assert.deepEqual(
    undeclared,
    [],
    `Route(s) that neither use withAuthenticatedApi nor appear in DIFFERENTLY_AUTHENTICATED: ${undeclared.join(', ')}. `
      + 'Wrap the handler (which forces a `requires` declaration), or add it to the list above with its auth mechanism.',
  )
})

test('the differently-authenticated list has no stale entries', () => {
  // A deleted or converted route left on the list would silently widen the
  // exemption for whatever later takes its path.
  const present = new Set(routeFiles.map(({ route }) => route))
  const stale = DIFFERENTLY_AUTHENTICATED.filter((entry) => !present.has(entry.route)).map((e) => e.route)
  assert.deepEqual(stale, [], `Listed route(s) no longer exist: ${stale.join(', ')}`)
})

test('listed routes really do avoid the wrapper', () => {
  // Catches the reverse drift: a route converted to withAuthenticatedApi but
  // left on the exemption list.
  //
  // Matches the CALL form, not the bare identifier: an exempt route should be
  // free to name the wrapper in a comment explaining why it opts out, and a
  // substring match would turn that documentation into a failure. A real
  // conversion is always a call — `export const GET = withAuthenticatedApi(`.
  const byRoute = new Map(routeFiles.map(({ route, source }) => [route, source]))
  const wrapped = DIFFERENTLY_AUTHENTICATED
    .filter((entry) => byRoute.get(entry.route)?.includes('withAuthenticatedApi('))
    .map((e) => e.route)
  assert.deepEqual(wrapped, [], `Now using withAuthenticatedApi — remove from the list: ${wrapped.join(', ')}`)
})

test('every declared capability is a real Capability', () => {
  const allowed = new Set<string>([...CAPABILITIES, 'member'])
  const bad: string[] = []
  for (const { route, source } of routeFiles) {
    for (const match of source.matchAll(/requires:\s*'([^']+)'/g)) {
      if (!allowed.has(match[1])) bad.push(`${route}: ${match[1]}`)
    }
  }
  assert.deepEqual(bad, [], `Unknown capability in a route declaration: ${bad.join(', ')}`)
})

test('every wrapped route declares requires for each exported handler', () => {
  // withAuthenticatedApi's second argument is mandatory in TypeScript, so this
  // is belt-and-braces — but it also catches a handler wrapped indirectly in a
  // way the type checker cannot see.
  const missing: string[] = []
  for (const { route, source } of routeFiles) {
    const wrapCount = (source.match(/withAuthenticatedApi\(/g) ?? []).length
    const declareCount = (source.match(/requires:\s*'/g) ?? []).length
    if (wrapCount > 0 && declareCount < wrapCount) missing.push(`${route} (${declareCount}/${wrapCount})`)
  }
  assert.deepEqual(missing, [], `Wrapped handler(s) without a requires declaration: ${missing.join(', ')}`)
})

/**
 * The billing routes are exempt from withAuthenticatedApi so a PLAN-locked
 * workspace can still reach checkout. That exemption was never meant to drop
 * the ROLE check too: billing:manage is admin-only in permissions.ts, and
 * without this test the routes can silently fall back to "any member with a
 * session", which is how the gap arose in the first place.
 */
const BILLING_MUTATION_ROUTES = ['stripe/checkout', 'stripe/portal', 'stripe/topup'] as const

test('billing routes enforce billing:manage despite skipping the wrapper', () => {
  const byRoute = new Map(routeFiles.map(({ route, source }) => [route, source]))
  const unguarded = BILLING_MUTATION_ROUTES.filter(
    (route) => !byRoute.get(route)?.includes('canManageBillingByRole'),
  )
  assert.deepEqual(
    unguarded,
    [],
    `Billing route(s) with no role check: ${unguarded.join(', ')}. `
      + 'The plan exemption does not extend to role — call canManageBillingByRole.',
  )
})

/**
 * resource:takeover promises more than "admins only" — permissions.ts calls it
 * "Always audited", and elevated.ts states the invariant plainly: the code
 * path that GRANTS cross-owner access is the same one that RECORDS it, so
 * reading a colleague's work without a trace is meant to be inexpressible.
 *
 * A route-level `requires: 'resource:takeover'` is a SECOND grant path, and it
 * carries no audit. Declaring the capability without calling withElevatedAccess
 * therefore silently breaks the promise — which is exactly how the members
 * resource-listing route came to read other people's flows, agents and goals
 * with nothing written to the audit log.
 */
test('every resource:takeover route routes its access through withElevatedAccess', () => {
  const unaudited = routeFiles
    .filter(({ source }) => source.includes("requires: 'resource:takeover'"))
    .filter(({ source }) => !source.includes('withElevatedAccess('))
    .map(({ route }) => route)
    .sort()

  assert.deepEqual(
    unaudited,
    [],
    `Route(s) granting resource:takeover with no audit: ${unaudited.join(', ')}. `
      + 'Wrap the cross-owner access in withElevatedAccess so the grant and the audit row stay inseparable.',
  )
})
