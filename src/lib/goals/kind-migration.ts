/**
 * Goal kind reduction (spec 2026-07-28): seven kinds collapse to three
 * product lines. The map is the single source of truth shared by the SQL
 * migration, the template remap, and any future backfill.
 *
 * Unknown kinds fall back to 'kpi' rather than throwing: 'kpi' is the
 * open-ended line whose unit the user chooses, so it is the only safe
 * destination for a value we do not recognise.
 */
export const GOAL_KIND_VALUES = ['arr', 'quota', 'kpi'] as const
export type GoalKind = (typeof GOAL_KIND_VALUES)[number]

export const LEGACY_KIND_MAP: Record<string, GoalKind> = {
  arr: 'arr',
  mrr: 'arr',
  revenue: 'arr',
  quota: 'quota',
  savings: 'kpi',
  lead_gen: 'kpi',
  custom_kpi: 'kpi',
}

export function mapLegacyKind(kind: string): GoalKind {
  return LEGACY_KIND_MAP[kind] ?? 'kpi'
}
