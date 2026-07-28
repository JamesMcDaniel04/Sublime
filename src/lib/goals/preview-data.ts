/**
 * Synthetic DashboardData for previewing a goal that does not exist yet.
 * Shared by the Copilot draft preview and the template detail modal.
 *
 * Without a `seed` the metric series is empty — that is the Copilot preview's
 * long-standing behavior and it stays byte-identical. With a `seed` the series
 * is generated deterministically from it, so the template modal can show a
 * plausible trend that does not shimmer between renders. Seeded data is always
 * labeled as a sample by the caller; it is never presented as real.
 */
import type { GoalDetail, GoalMetricSeries, GoalSummary } from '@/lib/types'
import type { DashboardData } from '@/components/goals/widgets/goal-dashboard'

export type PreviewMetricInput = {
  label: string | null
  role: 'primary' | 'supporting' | 'component'
  unit: GoalSummary['unit']
  source: string
  metricKey: string
}

export type PreviewGoalInput = {
  name: string
  description?: string | null
  kind: GoalSummary['kind']
  direction: 'increase' | 'decrease'
  unit: GoalSummary['unit']
  startValue: number
  targetValue: number
  /** `YYYY-MM-DD`, or null for "90 days out". */
  targetDate: string | null
  recurrence: GoalSummary['recurrence']
  personal: boolean
  metrics: PreviewMetricInput[]
  /** Omit for an empty series; supply for a deterministic sample trend. */
  seed?: string
}

const SAMPLE_POINTS = 12
const DAY_MS = 24 * 60 * 60 * 1000

/** FNV-1a seed into an xorshift32 stream. Deterministic, no Math.random. */
function randomFrom(seed: string): () => number {
  let state = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index)
    state = Math.imul(state, 16777619)
  }
  state = state >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
}

/**
 * A sample series walking from `startValue` roughly 65% of the way toward
 * `targetValue`, with bounded jitter. Always clamped inside [start, target]
 * so a preview never shows an impossible reading.
 */
function seededDatapoints(
  seed: string,
  startValue: number,
  targetValue: number,
  now: number,
): GoalMetricSeries['datapoints'] {
  const random = randomFrom(seed)
  const span = targetValue - startValue
  const lower = Math.min(startValue, targetValue)
  const upper = Math.max(startValue, targetValue)
  return Array.from({ length: SAMPLE_POINTS }, (_, index) => {
    const progress = (index / (SAMPLE_POINTS - 1)) * 0.65
    const jitter = (random() - 0.5) * 0.08 * Math.abs(span)
    const value = Math.min(upper, Math.max(lower, startValue + span * progress + jitter))
    return {
      id: `preview-point-${index}`,
      value: Math.round(value * 100) / 100,
      capturedAt: new Date(now - (SAMPLE_POINTS - 1 - index) * 7 * DAY_MS).toISOString(),
      origin: 'sync' as const,
    }
  })
}

export function buildPreviewDashboardData(input: PreviewGoalInput): {
  data: DashboardData
  metricIds: string[]
} {
  const now = Date.now()
  const startAt = new Date(now).toISOString()
  const fallbackTarget = new Date(now + 90 * DAY_MS).toISOString()
  const metricIds = input.metrics.map((_, index) => `preview-${index}`)
  const primaryIndex = Math.max(
    0,
    input.metrics.findIndex((metric) => metric.role === 'primary'),
  )

  const metrics: GoalMetricSeries[] = input.metrics.map((metric, index) => ({
    id: metricIds[index],
    label: metric.label,
    role: metric.role,
    unit: metric.unit,
    source: metric.source,
    metricKey: metric.metricKey,
    lastSyncAt: null,
    lastError: null,
    datapoints:
      input.seed && index === primaryIndex
        ? seededDatapoints(input.seed, input.startValue, input.targetValue, now)
        : [],
  }))

  const series = metrics[primaryIndex]?.datapoints ?? []
  let currentValue: number | null = null
  if (series.length) {
    currentValue = series[series.length - 1].value
  } else if (Number.isFinite(input.startValue)) {
    currentValue = input.startValue
  }

  const goal: GoalDetail = {
    id: 'preview',
    recoveryPlan: null,
    // A preview goal has no persisted provenance — the dashboard widgets it
    // feeds never read this, and no bundle is resolved from sample data.
    templateKey: null,
    name: input.name,
    description: input.description ?? null,
    kind: input.kind,
    direction: input.direction,
    unit: input.unit,
    startValue: input.startValue,
    targetValue: input.targetValue,
    startAt,
    targetDate: input.targetDate ? `${input.targetDate}T23:59:59` : fallbackTarget,
    recurrence: input.recurrence,
    status: 'active',
    riskLevel: 'no_data',
    personal: input.personal,
    parentGoalId: null,
    metric: null,
    metrics,
    dashboardLayout: null,
    currentValue,
    progress: null,
    expectedProgress: 0,
    projectedValue: null,
    children: [],
    periods: [],
    benchmark: null,
  }

  return {
    metricIds,
    data: {
      goal,
      metrics,
      contributions: [],
      impact: {
        measured: { runsCompleted: 0, tokens: 0, aiRunSecondsTotal: 0 },
        estimated: {
          hoursSaved: 0,
          laborValueUsd: 0,
          aiCostUsd: 0,
          roiMultiple: null,
          hourlyRateUsd: 0,
          aiCostPerMTokensUsd: 0,
        },
        correlated: { paceDeltaPct: null },
      },
      preview: true,
      onReload: () => {},
    },
  }
}
