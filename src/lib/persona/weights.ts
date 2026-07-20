/**
 * Pure persona math. Three signal kinds feed department weights:
 *   - connected tools (+1 per anchor department — presence only)
 *   - scanned connections (+2 — evidence of real usage, weighted above presence)
 *   - activity-ledger volume (+log10(count+1), capped — observed behavior)
 * Glue tools (slack/gmail/…) contribute nothing: departmentsForTools maps
 * them to ['general'], which is the no-signal fallback, never a weight.
 * Kept dependency-light (type-only indexer import) so it unit-tests without
 * Prisma or the graph store.
 */
import { DEPARTMENTS, departmentsForTools, type Department } from '@/lib/templates/departments'
import type { PendingNode } from '@/lib/rag/indexer'

export type PersonaSignals = {
  connectedToolSlugs: string[]
  scannedConnectionSlugs: string[]
  activityEventCounts: Record<string, number>
}

const CONNECTED_WEIGHT = 1
const SCANNED_WEIGHT = 2
const ACTIVITY_WEIGHT_CAP = 3

export function computeDepartmentWeights(signals: PersonaSignals): Record<Department, number> {
  const raw = new Map<Department, number>()
  const add = (slug: string, amount: number) => {
    const departments = departmentsForTools([slug])
    if (departments.length === 1 && departments[0] === 'general') return // glue/unknown — no department signal
    for (const department of departments) raw.set(department, (raw.get(department) ?? 0) + amount)
  }
  for (const slug of new Set(signals.connectedToolSlugs)) add(slug, CONNECTED_WEIGHT)
  for (const slug of new Set(signals.scannedConnectionSlugs)) add(slug, SCANNED_WEIGHT)
  for (const [slug, count] of Object.entries(signals.activityEventCounts)) {
    if (count > 0) add(slug, Math.min(ACTIVITY_WEIGHT_CAP, Math.log10(count + 1)))
  }
  const weights = Object.fromEntries(DEPARTMENTS.map((d) => [d, 0])) as Record<Department, number>
  const total = [...raw.values()].reduce((a, b) => a + b, 0)
  if (total === 0) return { ...weights, general: 1 }
  for (const [department, value] of raw) weights[department] = value / total
  return weights
}

/** Narrative requires observed usage — a scan profile or activity events. Mere connections never qualify. */
export function hasNarrativeSignal(signals: PersonaSignals): boolean {
  return signals.scannedConnectionSlugs.length > 0 || Object.values(signals.activityEventCounts).some((count) => count > 0)
}

/**
 * The graph projection of a persona. The graph has no organization node —
 * every node is already org-scoped by organizationId — so the persona is a
 * standalone org-shared insight node with a stable id (upserts in place),
 * not an edge to anything.
 */
export function personaGraphNode(
  organizationId: string,
  weights: Record<Department, number>,
  narrative: string | null,
): PendingNode {
  const top = (Object.entries(weights) as [Department, number][])
    .filter(([department, weight]) => weight > 0 && department !== 'general')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  return {
    id: `persona:${organizationId}`,
    type: 'insight',
    text: [
      `Organization persona: ${top.map(([d, w]) => `${d} (${Math.round(w * 100)}%)`).join(', ') || 'general'}.`,
      narrative ?? '',
    ].join(' ').trim().slice(0, 1500),
    props: { kind: 'persona', departmentWeights: weights },
    visibility: 'shared',
  }
}

/** Tolerant reader for the persisted Json weights — safe on junk/legacy shapes. */
export function topPersonaDepartments(weights: unknown, limit = 3): string[] {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) return []
  return Object.entries(weights as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0 && entry[0] !== 'general')
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([department]) => department)
}
