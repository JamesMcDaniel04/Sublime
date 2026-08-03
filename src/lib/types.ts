/**
 * Canonical client-side domain types. Import these instead of redeclaring
 * `Agent`/`Activity` shapes per component (which drift out of sync). Components
 * that need a subset should `Pick<Agent, …>` from here so there's one source.
 */
import type { GoalKind } from '@/lib/goals/kind-migration'
import type { CompositionState } from '@/lib/goals/composition'

export type { GoalKind }

export type Agent = {
  id: string
  title: string
  description: string
  instructions: string
  model: string
  integrations: string[]
  specialistArea?: string
  skills: string[]
  icon: string
  folder: string | null
  visibility: 'shared' | 'private'
  status: string
  priority: string
  schedule: { type: string; isActive: boolean }
}

export type Activity = {
  id: string
  agentTaskId?: string | null
  agentType: string
  status: string
  /** Omitted from the polled activity list (lean payload); present on run detail. */
  input?: any
  output?: any
  error?: string | null
  metadata?: any
  startedAt: string
  completedAt?: string | null
}

/** Human labels for goal kinds — raw enum text ("CUSTOM_KPI") never renders. */
export const GOAL_KIND_LABELS: Record<GoalKind, string> = {
  arr: 'ARR',
  quota: 'Quota',
  kpi: 'KPI',
}

/** The kind implies the unit; only `kpi` lets the user choose (null), since it
 *  spans former savings (usd), lead_gen (count) and custom KPIs. */
export const GOAL_KIND_UNITS: Record<GoalKind, GoalSummary['unit'] | null> = {
  arr: 'usd',
  quota: 'usd',
  kpi: null,
}

export interface GoalSummary {
  id: string
  name: string
  kind: GoalKind
  direction: 'increase' | 'decrease'
  unit: 'usd' | 'count' | 'percent'
  startValue: number
  targetValue: number
  startAt: string
  targetDate: string
  recurrence: 'monthly' | 'quarterly' | 'yearly' | null
  status: 'active' | 'paused' | 'achieved' | 'missed' | 'archived'
  riskLevel: 'on_track' | 'at_risk' | 'off_track' | 'no_data'
  personal: boolean
  /** True when access = 'restricted'. Only ever seen by people who can already
   *  see the goal, so it reveals nothing to anyone else. */
  restricted?: boolean
  parentGoalId: string | null
  metric: {
    source: string
    metricKey: string
    lastSyncAt: string | null
    lastError: string | null
  } | null
  currentValue: number | null
  progress: number | null
  expectedProgress: number
  /** Per-evaluation composition summary; null or absent when uncomposed. */
  compositionState?: CompositionState | null
  sparkline: Array<{ value: number; capturedAt: string }>
}

export interface GoalMetricSeries {
  id: string
  label: string | null
  role: 'primary' | 'supporting' | 'component'
  /** Which composition slot this series fills — 'new_arr', 'stage:2',
   *  'pipeline_coverage'. Null for primary and supporting series. */
  slot?: string | null
  unit: GoalSummary['unit']
  source: string
  metricKey: string
  lastSyncAt: string | null
  lastError: string | null
  datapoints: Array<{
    id: string
    value: number
    capturedAt: string
    origin: 'sync' | 'manual' | 'backfill' | 'assisted'
  }>
}

/** One actionable step of an open recovery plan. */
export interface RecoveryActionView {
  id: string
  kind: 'connect_tool' | 'launch_agent' | 'manual_step'
  title: string
  rationale: string
  payload: Record<string, unknown>
  status: 'proposed' | 'accepted' | 'done' | 'dismissed'
  resultRef: string | null
}

/** The goal's open AI recovery plan, rendered as the get-back-on-track strip. */
export interface RecoveryPlanView {
  id: string
  status: 'open'
  triggerRiskLevel: 'at_risk' | 'off_track'
  diagnosis: string
  evidence: string[]
  createdAt: string
  actions: RecoveryActionView[]
}

/** Reflection's run→goal contribution verdicts, aggregated for the funnel. */
export interface RunVerdictSummary {
  /** Last-30-day counts; total is the sum of the four verdicts. */
  counts: {
    advanced: number
    no_change: number
    unclear: number
    counterproductive: number
  }
  recent: Array<{
    id: string
    resourceType: 'agent' | 'flow'
    resourceId: string
    runId: string
    verdict: 'advanced' | 'no_change' | 'unclear' | 'counterproductive'
    evidence: string
    createdAt: string
  }>
}

/** GET /api/goals/[id] response shape, shared with dashboard widgets. */
export interface GoalDetail extends Omit<GoalSummary, 'sparkline'> {
  recoveryPlan: RecoveryPlanView | null
  /** Multi-goal arbitration rank; lower = more important, null = automatic. */
  priority: number | null
  /** Run→goal contribution verdicts (last 30 days); null when none exist. */
  runVerdicts: RunVerdictSummary | null
  description: string | null
  projectedValue: number | null
  metric: (GoalSummary['metric'] & { id: string }) | null
  metrics: GoalMetricSeries[]
  dashboardLayout: unknown | null
  /** The declared composition shape, so the editor can recover what was saved. */
  composition: unknown | null
  /** Per-evaluation composition summary; null for uncomposed goals. */
  compositionState: CompositionState | null
  /** The GoalTemplate this goal was created from; null for Copilot-drafted and
   *  manually-created goals. Drives the curated agent bundle. */
  templateKey: string | null
  children: Array<{
    id: string | null
    name: string
    riskLevel: GoalSummary['riskLevel']
    personal: boolean
  }>
  periods: Array<{
    periodStart: string
    periodEnd: string
    targetValue: number
    finalValue: number
    outcome: 'achieved' | 'missed'
  }>
  benchmark: {
    orgCount: number
    achievedRate: number
    topSeeds: Array<{ seedKey: string; name: string; deploys: number }>
  } | null
}
