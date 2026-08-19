/**
 * Structural guard matrix for expensive routes (LLM spend, embeddings,
 * outbound sampling). Same technique as global-sweeps.test.ts: parse the
 * route source and require the guard call to be present. This can't prove
 * the guard is wired correctly — the e2e suites do that where practical —
 * but it makes "new expensive route with no guard" a red build instead of a
 * silent cost hole (the 2026-08-01 QA audit found four such routes).
 *
 * Matrix semantics:
 *  - rateLimit: either an inline `rateLimit(` call or a `rateLimit: {`
 *    route-access option — both throttle.
 *  - budget: `checkMonthlyTokenBudget(` — routes that spend model tokens
 *    must refuse when the workspace ceiling is reached.
 *  - record: `meterTokens(` — whoever spends must also meter, else the ceiling
 *    is checked against a counter that never moves. Recording may live in the
 *    lib the route calls; the matrix points at that file.
 *
 *    meterTokens (lib/usage/meter.ts) is the required chokepoint: it logs a
 *    dropped write instead of swallowing it. A bare recordTokenUsage call is
 *    accepted ONLY where the result is awaited and acted on — the agent loop
 *    reads the running total to enforce the in-run ceiling.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..', '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

const hasRateLimit = (src: string) => src.includes('rateLimit(') || src.includes('rateLimit: {')

const ROUTES: Array<{
  file: string
  rateLimit?: boolean
  budget?: boolean
  record?: boolean
}> = [
  // LLM routes — full guard set in the route itself.
  { file: 'src/app/api/assistant/chat/route.ts', rateLimit: true, budget: true, record: true },
  { file: 'src/app/api/agents/draft/route.ts', rateLimit: true, budget: true, record: true },
  { file: 'src/app/api/flows/copilot/route.ts', rateLimit: true, budget: true, record: true },
  { file: 'src/app/api/flows/copilot/chat/route.ts', rateLimit: true, budget: true, record: true },
  { file: 'src/app/api/goals/copilot/draft/route.ts', rateLimit: true, budget: true, record: true },
  { file: 'src/app/api/templates/ai-search/route.ts', rateLimit: true, budget: true, record: true },
  { file: 'src/app/api/integrations/ai-search/route.ts', rateLimit: true, budget: true, record: true },
  // Scan runs LLM distillation + live tool sampling; metering lives in the
  // shared scan lib so the cron path meters too.
  { file: 'src/app/api/intelligence/rescan/route.ts', rateLimit: true, budget: true },
  { file: 'src/lib/intelligence/connection-scan.ts', record: true },
  // Assisted metric previews run LLM extraction; url/sheets/etc do not, so
  // the route gates budget on the assisted sources only — but it must gate.
  { file: 'src/app/api/goals/metrics/preview/route.ts', rateLimit: true, budget: true },
  { file: 'src/lib/metrics/assisted-extraction.ts', record: true },
  // Uploads fan out into embedding generation — throttle even without a
  // token-budget tie-in.
  { file: 'src/app/api/agents/[id]/knowledge/route.ts', rateLimit: true },
]

for (const route of ROUTES) {
  test(`${route.file} carries its cost guards`, () => {
    const src = read(route.file)
    if (route.rateLimit) assert.ok(hasRateLimit(src), `${route.file}: missing rateLimit`)
    if (route.budget) assert.ok(src.includes('checkMonthlyTokenBudget('), `${route.file}: missing checkMonthlyTokenBudget`)
    if (route.record) {
      const metered = src.includes('meterTokens(')
        // The agent loop awaits the returned month total to enforce its own cap.
        || /const \w+ = await recordTokenUsage\(/.test(src)
      assert.ok(metered, `${route.file}: spends tokens without metering through meterTokens()`)
      assert.ok(
        !/void recordTokenUsage\([^)]*\)\.catch\(\(\) => undefined\)/.test(src),
        `${route.file}: fire-and-forget metering swallows dropped spend — use meterTokens()`,
      )
    }
  })
}
