import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeImpact, paceDelta } from '../impact'

const DAY = 24 * 60 * 60 * 1000
const t0 = new Date('2026-01-01T00:00:00Z')
const pt = (n: number, value: number) => ({
  value,
  capturedAt: new Date(t0.getTime() + n * DAY),
})

test('impact tiers: hours, labor value, ROI multiple', () => {
  const impact = computeImpact({
    contributions: [
      { estimatedMinutesSavedPerRun: 30, runs: 10, tokens: 2_000_000, measuredRunSeconds: { total: 420, avg: 42 } },
      { estimatedMinutesSavedPerRun: 60, runs: 2, tokens: 0, measuredRunSeconds: { total: 90, avg: 45 } },
    ],
    hourlyRateUsd: 50,
    aiCostPerMTokensUsd: 10,
    paceBefore: 1,
    paceAfter: 1.5,
  })
  assert.equal(impact.measured.runsCompleted, 12)
  assert.equal(impact.measured.tokens, 2_000_000)
  assert.equal(impact.measured.aiRunSecondsTotal, 510)
  assert.equal(impact.estimated.hoursSaved, 7)
  assert.equal(impact.estimated.laborValueUsd, 350)
  assert.equal(impact.estimated.aiCostUsd, 20)
  assert.equal(impact.estimated.roiMultiple, 17.5)
  assert.equal(impact.correlated.paceDeltaPct, 50)
})

test('zero AI cost produces a null ROI multiple', () => {
  const impact = computeImpact({
    contributions: [{ estimatedMinutesSavedPerRun: 30, runs: 4, tokens: 0, measuredRunSeconds: { total: 80, avg: 20 } }],
    hourlyRateUsd: 50,
    aiCostPerMTokensUsd: 10,
    paceBefore: null,
    paceAfter: null,
  })
  assert.equal(impact.estimated.roiMultiple, null)
  assert.equal(impact.correlated.paceDeltaPct, null)
})

test('paceDelta splits the series at the first contribution', () => {
  const points = [
    pt(0, 100),
    pt(5, 105),
    pt(9, 109),
    pt(11, 115),
    pt(15, 127),
    pt(20, 142),
  ]
  const { before, after } = paceDelta(points, new Date(t0.getTime() + 10 * DAY))
  assert.ok(Math.abs((before ?? 0) - 1) < 0.05)
  assert.ok(Math.abs((after ?? 0) - 3) < 0.05)
})

test('paceDelta returns null when a side has fewer than two points', () => {
  const { before, after } = paceDelta(
    [pt(11, 115), pt(15, 127)],
    new Date(t0.getTime() + 10 * DAY),
  )
  assert.equal(before, null)
  assert.ok(after !== null)
})

test('pure duration stats: unmeasurable flow runs leave the denominator', async () => {
  const { flowRunStatsOf, agentRunStatsOf } = await import('../impact')
  const t0 = new Date('2026-01-01T00:00:00Z')
  const flow = flowRunStatsOf([
    { startedAt: t0, finishedAt: new Date(t0.getTime() + 42_000) },
    { startedAt: t0, finishedAt: null }, // succeeded but unmeasurable — excluded entirely
    { startedAt: t0, finishedAt: new Date(t0.getTime() + 18_000) },
  ])
  assert.equal(flow.runs, 2)
  assert.equal(flow.measuredRunSeconds.total, 60)
  assert.equal(flow.measuredRunSeconds.avg, 30)

  const agent = agentRunStatsOf([
    { inputTokens: 1000, outputTokens: 500, executionTime: 90_000 }, // ms → 90s
    { inputTokens: 200, outputTokens: 100, executionTime: null },
  ])
  assert.equal(agent.runs, 2)
  assert.equal(agent.tokens, 1800)
  assert.equal(agent.measuredRunSeconds.total, 90)
  assert.equal(agent.measuredRunSeconds.avg, 45)

  assert.deepEqual(flowRunStatsOf([]).measuredRunSeconds, { total: 0, avg: null })
})
