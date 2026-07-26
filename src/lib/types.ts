/**
 * Canonical client-side domain types. Import these instead of redeclaring
 * `Agent`/`Activity` shapes per component (which drift out of sync). Components
 * that need a subset should `Pick<Agent, …>` from here so there's one source.
 */

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
export const GOAL_KIND_LABELS: Record<GoalSummary['kind'], string> = {
  arr: 'ARR',
  mrr: 'MRR',
  revenue: 'Revenue',
  quota: 'Quota',
  savings: 'Savings',
  lead_gen: 'Lead Gen',
  custom_kpi: 'Custom KPI',
}

/** The kind implies the unit; only custom_kpi lets the user choose (null). */
export const GOAL_KIND_UNITS: Record<GoalSummary['kind'], GoalSummary['unit'] | null> = {
  arr: 'usd',
  mrr: 'usd',
  revenue: 'usd',
  quota: 'usd',
  savings: 'usd',
  lead_gen: 'count',
  custom_kpi: null,
}

export interface GoalSummary {
  id: string
  name: string
  kind: 'arr' | 'mrr' | 'revenue' | 'quota' | 'savings' | 'lead_gen' | 'custom_kpi'
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
  sparkline: Array<{ value: number; capturedAt: string }>
}
