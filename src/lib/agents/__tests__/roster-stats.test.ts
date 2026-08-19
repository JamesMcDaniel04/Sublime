import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeAgentKpis, hasRunHistory, mergeAgentKpis, pickKpiSlots } from '../roster-stats'

const noContributions: Parameters<typeof computeAgentKpis>[0]['contributions'] = []

test('counts delivered work: runs is completed runs, not attempts', () => {
  const kpis = computeAgentKpis({
    tallies: [
      { status: 'completed', count: 12 },
      { status: 'failed', count: 3 },
    ],
    contributions: noContributions,
  })
  assert.equal(kpis.runs, 12)
  assert.equal(kpis.failed, 3)
})

// A run paused for a human answer has not failed — it is still in flight.
// Putting it in the denominator would make every question look like a defect.
test('non-terminal runs stay out of the success rate entirely', () => {
  const kpis = computeAgentKpis({
    tallies: [
      { status: 'completed', count: 9 },
      { status: 'failed', count: 1 },
      { status: 'waiting_for_input', count: 5 },
      { status: 'running', count: 2 },
      { status: 'pending', count: 4 },
    ],
    contributions: noContributions,
  })
  assert.equal(kpis.successRate, 90)
})

// A human stopping a run is not the agent being unreliable.
test('a cancelled run counts against neither side of the success rate', () => {
  const kpis = computeAgentKpis({
    tallies: [
      { status: 'completed', count: 4 },
      { status: 'cancelled', count: 6 },
    ],
    contributions: noContributions,
  })
  assert.equal(kpis.successRate, 100)
  assert.equal(kpis.runs, 4)
})

test('success rate is null when nothing has reached a terminal state yet', () => {
  const kpis = computeAgentKpis({ tallies: [{ status: 'running', count: 2 }], contributions: noContributions })
  assert.equal(kpis.successRate, null)
})

test('hours saved is null for an agent linked to no goal, so the tile can fall back to runs', () => {
  const kpis = computeAgentKpis({ tallies: [{ status: 'completed', count: 10 }], contributions: noContributions })
  assert.equal(kpis.hoursSaved, null)
})

test('hours saved multiplies the per-run estimate by delivered runs only', () => {
  const kpis = computeAgentKpis({
    tallies: [
      { status: 'completed', count: 10 },
      { status: 'failed', count: 90 },
    ],
    contributions: [{ estimatedMinutesSavedPerRun: 30, estimateEdited: false, createdAt: new Date('2026-01-01') }],
  })
  assert.equal(kpis.hoursSaved, 5)
})

// An agent can serve several goals, each with its own estimate. A human-edited
// estimate is ground truth; provisioned defaults are guesses.
test('a human-edited estimate wins over a larger provisioned default', () => {
  const kpis = computeAgentKpis({
    tallies: [{ status: 'completed', count: 2 }],
    contributions: [
      { estimatedMinutesSavedPerRun: 240, estimateEdited: false, createdAt: new Date('2026-03-01') },
      { estimatedMinutesSavedPerRun: 30, estimateEdited: true, createdAt: new Date('2026-01-01') },
    ],
  })
  assert.equal(kpis.minutesSavedPerRun, 30)
  assert.equal(kpis.hoursSaved, 1)
})

test('with several human-edited estimates the most recent one wins', () => {
  const kpis = computeAgentKpis({
    tallies: [{ status: 'completed', count: 1 }],
    contributions: [
      { estimatedMinutesSavedPerRun: 30, estimateEdited: true, createdAt: new Date('2026-01-01') },
      { estimatedMinutesSavedPerRun: 60, estimateEdited: true, createdAt: new Date('2026-06-01') },
    ],
  })
  assert.equal(kpis.minutesSavedPerRun, 60)
})

test('with no edited estimate the most recent provisioned default wins', () => {
  const kpis = computeAgentKpis({
    tallies: [{ status: 'completed', count: 1 }],
    contributions: [
      { estimatedMinutesSavedPerRun: 30, estimateEdited: false, createdAt: new Date('2026-01-01') },
      { estimatedMinutesSavedPerRun: 45, estimateEdited: false, createdAt: new Date('2026-06-01') },
    ],
  })
  assert.equal(kpis.minutesSavedPerRun, 45)
})

test('a goal-linked agent leads with hours saved, then reliability', () => {
  const kpis = computeAgentKpis({
    tallies: [
      { status: 'completed', count: 20 },
      { status: 'failed', count: 5 },
    ],
    contributions: [{ estimatedMinutesSavedPerRun: 45, estimateEdited: true, createdAt: new Date('2026-01-01') }],
  })
  const [first, second] = pickKpiSlots(kpis)
  assert.equal(first.key, 'hoursSaved')
  assert.equal(first.display, '15h')
  assert.equal(second.key, 'successRate')
  assert.equal(second.display, '80%')
})

test('an unlinked agent leads with runs instead of an empty hours slot', () => {
  const kpis = computeAgentKpis({
    tallies: [{ status: 'completed', count: 142 }],
    contributions: noContributions,
  })
  const [first, second] = pickKpiSlots(kpis)
  assert.equal(first.key, 'runs')
  assert.equal(first.display, '142')
  assert.equal(second.key, 'successRate')
  assert.equal(second.display, '100%')
})

test('a sub-hour saving keeps one decimal instead of rounding away to 0h', () => {
  const kpis = computeAgentKpis({
    tallies: [{ status: 'completed', count: 1 }],
    contributions: [{ estimatedMinutesSavedPerRun: 30, estimateEdited: true, createdAt: new Date('2026-01-01') }],
  })
  assert.equal(pickKpiSlots(kpis)[0].display, '0.5h')
})

test('a freshly hired agent has no run history to show', () => {
  const kpis = computeAgentKpis({ tallies: [], contributions: noContributions })
  assert.equal(hasRunHistory(kpis), false)
})

// The failure mode that would matter most: a broken agent must not be
// indistinguishable from one nobody has run yet.
test('an agent that has only ever failed still has history, and reports 0%', () => {
  const kpis = computeAgentKpis({ tallies: [{ status: 'failed', count: 3 }], contributions: noContributions })
  assert.equal(hasRunHistory(kpis), true)
  assert.equal(kpis.successRate, 0)
  assert.equal(pickKpiSlots(kpis)[1].display, '0%')
})

test('a run still in flight counts as history — the agent is working, not idle', () => {
  const kpis = computeAgentKpis({ tallies: [{ status: 'running', count: 1 }], contributions: noContributions })
  assert.equal(hasRunHistory(kpis), true)
  assert.equal(pickKpiSlots(kpis)[1].display, '—')
})

test('unknown future statuses are ignored rather than silently scoring as failures', () => {
  const kpis = computeAgentKpis({
    tallies: [
      { status: 'completed', count: 5 },
      { status: 'some_new_status', count: 50 },
    ],
    contributions: noContributions,
  })
  assert.equal(kpis.successRate, 100)
  assert.equal(kpis.runs, 5)
})

// ── Workers: one avatar, several agents ────────────────────────────────────

const kpisOf = (runs: number, failed: number, minutes?: number) =>
  computeAgentKpis({
    tallies: [
      { status: 'completed', count: runs },
      { status: 'failed', count: failed },
    ],
    contributions: minutes === undefined
      ? []
      : [{ estimatedMinutesSavedPerRun: minutes, estimateEdited: true, createdAt: new Date('2026-01-01') }],
  })

test('a worker totals the delivered work of every agent under it', () => {
  const merged = mergeAgentKpis([kpisOf(10, 1), kpisOf(32, 2)])
  assert.equal(merged.runs, 42)
  assert.equal(merged.failed, 3)
})

// Averaging the members' percentages would let an agent with a single lucky run
// outweigh one with a hundred, and the tile would overstate the worker.
test("a worker's success rate weights by volume, not by member", () => {
  const merged = mergeAgentKpis([kpisOf(50, 50), kpisOf(1, 0)])
  assert.equal(merged.successRate, 50, 'volume-weighted; averaging the rates would give 75')
})

test('a worker sums hours saved across the agents that have an estimate', () => {
  const merged = mergeAgentKpis([kpisOf(2, 0, 60), kpisOf(4, 0, 30)])
  assert.equal(merged.hoursSaved, 4)
})

test('hours saved stays null only when no agent under the worker is goal-linked', () => {
  assert.equal(mergeAgentKpis([kpisOf(3, 0), kpisOf(5, 0)]).hoursSaved, null)
  assert.equal(mergeAgentKpis([kpisOf(3, 0), kpisOf(2, 0, 30)]).hoursSaved, 1)
})

test('a worker whose agents have never run shows no history', () => {
  assert.equal(hasRunHistory(mergeAgentKpis([kpisOf(0, 0), kpisOf(0, 0)])), false)
})

test('an empty worker reports zeroes rather than throwing', () => {
  const merged = mergeAgentKpis([])
  assert.equal(merged.runs, 0)
  assert.equal(merged.successRate, null)
  assert.equal(merged.hoursSaved, null)
  assert.equal(hasRunHistory(merged), false)
})

// ── Attention signals ──────────────────────────────────────────────────────
// The roster's job is telling a manager where to look. "Blocked on you" is the
// single most actionable thing a tile can say, so it is counted, not inferred.

test('runs paused on a question are counted so a tile can say it is blocked on you', () => {
  const kpis = computeAgentKpis({
    tallies: [
      { status: 'completed', count: 4 },
      { status: 'waiting_for_input', count: 2 },
    ],
    contributions: noContributions,
  })
  assert.equal(kpis.waiting, 2)
})

test('queued and in-flight runs both count as working, so a tile can show live activity', () => {
  const kpis = computeAgentKpis({
    tallies: [
      { status: 'running', count: 1 },
      { status: 'pending', count: 3 },
    ],
    contributions: noContributions,
  })
  assert.equal(kpis.running, 4)
})

test('a finished agent is neither waiting nor working', () => {
  const kpis = computeAgentKpis({ tallies: [{ status: 'completed', count: 9 }], contributions: noContributions })
  assert.equal(kpis.waiting, 0)
  assert.equal(kpis.running, 0)
})

test('a worker inherits attention from any agent under it', () => {
  const blocked = computeAgentKpis({ tallies: [{ status: 'waiting_for_input', count: 1 }], contributions: [] })
  const busy = computeAgentKpis({ tallies: [{ status: 'running', count: 2 }], contributions: [] })
  const merged = mergeAgentKpis([blocked, busy])
  assert.equal(merged.waiting, 1)
  assert.equal(merged.running, 2)
})
