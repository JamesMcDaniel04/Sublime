/**
 * Baselines as graph facts. Routing them through writeInference is deliberate:
 * that path structurally rejects an inference with no evidence, so a baseline
 * in the graph is always traceable to the activity rows it was measured from.
 * The suggestion layer cites these nodes in turn, which is what lets a
 * recommendation carry a provenance chain rather than an assertion.
 */
import { writeInference } from '@/lib/activity/insights'
import type { ComputedBaseline, ProcessKey } from './types'

export function baselineSlug(key: ProcessKey): string {
  return `${key.source}-${key.action}-${key.entityType}`
}

/** Facts, phrased as facts. Interpretation belongs to the recommendation nodes
 *  that cite this one, never to the fact itself. */
export function baselineInferenceText(baseline: ComputedBaseline): string {
  const parts = [
    `${baseline.action} on ${baseline.entityType} (${baseline.source}): ${baseline.volume} occurrences over ${baseline.windowDays} days`,
    `${baseline.distinctActors} people involved`,
  ]
  if (baseline.periodDays !== null) parts.push(`typical gap ${baseline.periodDays.toFixed(1)} days`)
  if (baseline.medianCycleTimeHours !== null) {
    parts.push(`median cycle time ${baseline.medianCycleTimeHours.toFixed(0)} hours`)
  }
  if (baseline.reworkRate !== null) parts.push(`rework ${Math.round(baseline.reworkRate * 100)}%`)
  return parts.join('; ')
}

export async function projectBaseline(
  organizationId: string,
  baseline: ComputedBaseline,
  evidenceEventIds: string[],
): Promise<boolean> {
  if (evidenceEventIds.length === 0) return false
  return writeInference({
    organizationId,
    kind: 'inferred_pattern',
    slug: baselineSlug(baseline),
    text: baselineInferenceText(baseline),
    evidenceEventIds,
  })
}
