/** Provider-neutral workspace event types available for signal automations. */
export const SIGNAL_TYPES = [
  'deal.score_updated',
  'deal.risk_detected',
  'deal.stage_changed',
  'forecast.updated',
  'insight.generated',
  'stakeholder.engagement_changed',
] as const
