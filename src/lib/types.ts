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

export interface GoalSummary {
  id: string
  name: string
  kind: 'arr' | 'mrr' | 'carr' | 'revenue' | 'quota' | 'savings' | 'custom_kpi'
  direction: 'increase' | 'decrease'
  unit: 'usd' | 'count' | 'percent'
  startValue: number
  targetValue: number
  startAt: string
  targetDate: string
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
