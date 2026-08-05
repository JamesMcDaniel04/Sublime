/**
 * The baseline layer's view of an activity row. Deliberately narrower than
 * ActivityEvent: baselines measure shape and timing, never content, so no
 * field here can carry a message body, subject line, or record contents.
 */
export interface ProcessKey {
  source: string
  action: string
  entityType: string
}

export interface BaselineEvent extends ProcessKey {
  entityRef: string
  actorRef: string
  occurredAt: Date
  previousState: unknown
  newState: unknown
}

export interface ComputedBaseline extends ProcessKey {
  volume: number
  windowDays: number
  periodDays: number | null
  distinctActors: number
  medianCycleTimeHours: number | null
  reworkRate: number | null
  confidence: number
}
