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
