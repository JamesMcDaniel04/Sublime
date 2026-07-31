/**
 * Structural guarantee: every authenticated MUTATION handler is exercised by
 * some test, or is listed below as a known gap.
 *
 * route-smoke.test.ts already does this for GET. Mutations had no equivalent,
 * which is the wrong way round — a GET that breaks shows a wrong screen, while
 * a POST/PUT/PATCH/DELETE that breaks writes wrong data, skips an
 * authorization check, or silently no-ops. At the time this guard was written
 * 57 of 115 mutation handlers (50%) had never been called by a test; the first
 * two were burned down immediately in mutation-routes-e2e.test.ts.
 *
 * The point is not to fix all 57 at once. It is to stop the number growing:
 * a NEW mutation route now fails CI unless it is tested or consciously
 * deferred, and PENDING_COVERAGE can only shrink, because a stale entry fails
 * too.
 *
 * "Exercised" means a test module imports that route module and names that
 * verb. Deliberately structural, not behavioural — it cannot tell a real
 * assertion from a smoke call. It answers "has anyone pointed a test at this
 * at all", which for half the mutation surface was no.
 *
 * No database required — it reads source, so it runs in the plain unit pass.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const API_DIR = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = path.resolve(API_DIR, '../..')

const VERBS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const

/**
 * Mutation handlers with no test pointing at them, captured as the baseline on
 * the day this guard landed. Each line is a debt, not a decision — the list
 * exists so the debt is visible and bounded, and entries should be deleted as
 * coverage arrives.
 *
 * Ordered roughly by how much logic lives in the route layer rather than in an
 * already-tested library beneath it, which is the useful burn-down order.
 */
const PENDING_COVERAGE: ReadonlySet<string> = new Set([
  // Highest value: substantial route-layer logic, no test at all.
  'executions/[id]/reply#POST',
  'flows/[id]/execute#POST',
  'connections/verify#POST',
  'flows/[id]/trigger-secret#POST',
  // Resource lifecycle.
  'agent-templates#PUT',
  'agent-templates#DELETE',
  'agents#DELETE',
  'agents/[id]/chat#PATCH',
  'agents/[id]/knowledge#DELETE',
  'agents/[id]/memories#PUT',
  'agents/[id]/memories#PATCH',
  'agents/[id]/memories#DELETE',
  'agents/[id]/runs/[runId]#POST',
  'agents/[id]/runs/[runId]#DELETE',
  'agents/[id]/skills#POST',
  'agents/[id]/skills#DELETE',
  'agents/draft#POST',
  'flows#DELETE',
  'flows/[id]/comments#PATCH',
  'flows/[id]/comments#DELETE',
  'flows/[id]/dismiss-suggestion#POST',
  'flows/[id]/runs/[runId]#PATCH',
  'flows/[id]/runs/[runId]#DELETE',
  'flows/[id]/runs/[runId]/resubmit#POST',
  'flows/[id]/suggestions#PATCH',
  'flows/[id]/versions#PATCH',
  'flows/[id]/versions#DELETE',
  'flows/signals/[name]#POST',
  'goals/[id]/contributions#DELETE',
  'goals/settings#PATCH',
  'knowledge#DELETE',
  'notifications/[id]#DELETE',
  'notifications/read#POST',
  'organizations#PATCH',
  'organizations#DELETE',
  'settings/profile#PATCH',
  'skills#PUT',
  'skills#DELETE',
  // Integration plumbing — most need a live third party to do anything real.
  'integrations/granola#DELETE',
  'integrations/granola/test#POST',
  'intelligence/learnings#DELETE',
  'intelligence/rescan#POST',
  'mcp-connections#PUT',
  'mcp-connections/discover#POST',
  'mcp-connections/test#POST',
  'nango/connections/[integrationId]#DELETE',
  'nango/session-token#POST',
  'postgres/connections/[id]/test#POST',
  'push/subscribe#POST',
  'push/subscribe#DELETE',
  // LLM-backed: degrade without a provider key, so a smoke case asserts the
  // degradation rather than the output.
  'flows/copilot#POST',
  'goals/copilot/draft#POST',
  'goals/metrics/preview#POST',
  'integrations/ai-search#POST',
  'templates/ai-search#POST',
])

function walk(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, match))
    else if (match(entry.name)) out.push(full)
  }
  return out
}

/** Every authenticated mutation handler, as "<route>#<VERB>". */
function mutationHandlers(): string[] {
  const out: string[] = []
  for (const file of walk(API_DIR, (n) => n === 'route.ts')) {
    if (file.includes(`${path.sep}__tests__${path.sep}`)) continue
    const source = readFileSync(file, 'utf8')
    const route = path.relative(API_DIR, path.dirname(file))
    for (const verb of VERBS) {
      if (new RegExp(`export const ${verb} = withAuthenticatedApi`).test(source)) {
        out.push(`${route}#${verb}`)
      }
    }
  }
  return out.sort()
}

/**
 * Route modules each test imports, mapped to the verbs that test names.
 * Import specifiers are RESOLVED rather than string-matched: a relative
 * `'../profile/route'` is the common form, and a substring search for the
 * api-relative path misses it — which understated coverage by four handlers
 * when this was first measured.
 */
function coveredHandlers(): Set<string> {
  const covered = new Set<string>()
  const specifier = /from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g
  const testFiles = walk(SRC_DIR, (n) => n.endsWith('.test.ts') || n.endsWith('.test.tsx'))

  for (const file of testFiles) {
    const source = readFileSync(file, 'utf8')
    const verbs = VERBS.filter((verb) => new RegExp(`\\b${verb}\\b`).test(source))
    if (verbs.length === 0) continue

    for (const match of source.matchAll(specifier)) {
      const spec = match[1] ?? match[2]
      if (!spec?.endsWith('/route')) continue
      const resolved = spec.startsWith('.')
        ? path.resolve(path.dirname(file), spec)
        : spec.startsWith('@/')
          ? path.resolve(SRC_DIR, spec.slice(2))
          : null
      if (!resolved) continue
      const route = path.relative(API_DIR, path.dirname(resolved))
      if (route.startsWith('..')) continue
      for (const verb of verbs) covered.add(`${route}#${verb}`)
    }
  }
  return covered
}

test('every authenticated mutation handler is tested or a listed known gap', () => {
  const covered = coveredHandlers()
  const untracked = mutationHandlers()
    .filter((handler) => !covered.has(handler) && !PENDING_COVERAGE.has(handler))

  assert.deepEqual(
    untracked,
    [],
    `Mutation handler(s) with no test and no PENDING_COVERAGE entry: ${untracked.join(', ')}. `
      + 'Add a test that imports the route and calls the verb, or add it to PENDING_COVERAGE above.',
  )
})

test('the pending list has no stale entries, so the debt can only shrink', () => {
  // Two ways an entry goes stale: the handler was deleted, or it got covered
  // and nobody removed the line. Both let the list quietly stop meaning
  // anything, so both fail here.
  const handlers = new Set(mutationHandlers())
  const covered = coveredHandlers()
  const gone = [...PENDING_COVERAGE].filter((h) => !handlers.has(h)).sort()
  const nowTested = [...PENDING_COVERAGE].filter((h) => covered.has(h)).sort()

  assert.deepEqual(gone, [], `PENDING_COVERAGE names handler(s) that no longer exist: ${gone.join(', ')}`)
  assert.deepEqual(
    nowTested,
    [],
    `PENDING_COVERAGE names handler(s) that ARE now tested — delete these lines: ${nowTested.join(', ')}`,
  )
})

test('the known-gap list is not silently growing', () => {
  // A ratchet. Raising this number is a deliberate, reviewable act; forgetting
  // to lower it after adding coverage fails the stale-entry test above.
  const BASELINE = 55
  assert.ok(
    PENDING_COVERAGE.size <= BASELINE,
    `PENDING_COVERAGE grew to ${PENDING_COVERAGE.size} (baseline ${BASELINE}). `
      + 'New mutation routes should ship with tests rather than joining the backlog.',
  )
})
