import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { globalSweepsAllowed } from '../global-sweeps'

const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const ORIGINAL_TEST_DB = process.env.TEST_DATABASE_URL

const setEnv = (nodeEnv: string | undefined, testDb: string | undefined) => {
  if (nodeEnv === undefined) delete (process.env as Record<string, unknown>).NODE_ENV
  else (process.env as Record<string, string>).NODE_ENV = nodeEnv
  if (testDb === undefined) delete process.env.TEST_DATABASE_URL
  else process.env.TEST_DATABASE_URL = testDb
}

afterEach(() => setEnv(ORIGINAL_NODE_ENV, ORIGINAL_TEST_DB))

/**
 * The dispatch tick runs CROSS-ORG sweeps that rewrite global tables
 * (template_adoptions, platform_archetypes, goal_benchmarks,
 * template_estimate_calibrations), refresh every org's goal metrics, and
 * consume weekly digest claims.
 *
 * Two e2e suites drive that route for real, and the runner executes suites in
 * PARALLEL against one shared database — so a tick fired by behavior-e2e can
 * rewrite the very rows capture-hardening-e2e or goals-e2e are asserting on.
 * Because the sweep gates read the wall clock, it only bites inside narrow UTC
 * windows (03:00-03:15, 04:00-04:15, Mondays), which is the worst possible
 * failure profile: rare, real, and reproducible for nobody.
 */
test('a shared test database suppresses cross-org sweeps', () => {
  setEnv('test', 'postgresql://qa@127.0.0.1:54339/sublime_qa')
  assert.equal(globalSweepsAllowed(), false)
})

test('production always sweeps, even if a test database url is present', () => {
  // The seam must never be able to disable real cron work. This is the
  // assertion that makes it safe to ship.
  setEnv('production', 'postgresql://qa@127.0.0.1:54339/sublime_qa')
  assert.equal(globalSweepsAllowed(), true)
})

test('a dev machine with no test database still sweeps', () => {
  setEnv('development', undefined)
  assert.equal(globalSweepsAllowed(), true)
})

test('every cross-org sweep in the dispatch tick sits behind the seam', () => {
  // Structural, because the route cannot be executed here. A sweep added later
  // without the guard reintroduces exactly the contamination this closes.
  const route = readFileSync(
    fileURLToPath(new URL('../../../app/api/cron/dispatch/route.ts', import.meta.url)),
    'utf8',
  )
  const CROSS_ORG_SWEEPS = [
    'aggregateTemplateAdoption',
    'aggregatePlatformArchetypes',
    'calibrateTemplateEstimates',
    'aggregateGoalBenchmarks',
    'sendWeeklyGoalDigests',
    'refreshGoalMetrics',
  ]
  // Checks the NEAREST ENCLOSING `if`, not a character window. A window is
  // wide enough to see the previous sweep's guard and pass even when this
  // sweep has none — verified by deleting a guard and watching this fail.
  const lines = route.split('\n')
  const unguarded = CROSS_ORG_SWEEPS.filter((sweep) => {
    const callLine = lines.findIndex((line) => line.includes(`${sweep}(`) && !line.trim().startsWith('*'))
    if (callLine < 0) return false
    for (let i = callLine; i >= 0 && callLine - i < 12; i--) {
      if (/^\s*(\} )?if \(/.test(lines[i])) return !lines[i].includes('globalSweepsAllowed()')
    }
    return true // no governing `if` found at all
  })
  assert.deepEqual(
    unguarded,
    [],
    `Cross-org sweep(s) fired without the shared-database guard: ${unguarded.join(', ')}.`,
  )
})
