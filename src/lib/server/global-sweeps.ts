/**
 * Whether this process may run the dispatch tick's CROSS-ORG sweeps.
 *
 * Those sweeps rewrite state nobody owns locally: the global aggregate tables
 * (template_adoptions, platform_archetypes, goal_benchmarks,
 * template_estimate_calibrations), every organization's goal metrics, the
 * weekly digest claims, and the per-tick activity incremental-sync (which
 * enumerates every org's connections and writes into their ledgers).
 *
 * That is correct in production and actively harmful against a shared test
 * database. Two e2e suites drive the real dispatch route, and the runner
 * executes suite files in PARALLEL against one Postgres — so a tick fired by
 * behavior-e2e rewrites rows that capture-hardening-e2e, intelligence-e2e or
 * goals-e2e are asserting on at that moment. Because the sweep gates read the
 * wall clock, the collision only happens inside narrow UTC windows (03:00,
 * 04:00, Mondays), producing failures that are rare, genuine, and reproducible
 * for nobody — the worst kind to debug. One instance of this class
 * (refreshGoalMetrics, which is not time-gated and so hit constantly) was
 * already tracked down the hard way.
 *
 * Production-inert BY CONSTRUCTION: double-gated on NODE_ENV and
 * TEST_DATABASE_URL, the same seam shape as setTestAuthContext in
 * ./auth.ts. Nothing is suppressed in production, and nothing is suppressed on
 * a developer machine that has no test database configured.
 *
 * This costs no coverage: every sweep keeps its own direct test, which calls
 * the aggregation function rather than the route. The two route-level tests
 * assert only that the tick returns 200 — they never assert a sweep produced
 * anything.
 *
 * Per-organization tick work (behavior mining, suggestion synthesis, activity
 * dispatch) is deliberately NOT gated here: it only touches the caller's own
 * seeded org, and behavior-e2e depends on it running.
 */
export function globalSweepsAllowed(): boolean {
  const sharedTestDatabase =
    process.env.NODE_ENV !== 'production' && Boolean(process.env.TEST_DATABASE_URL)
  return !sharedTestDatabase
}
