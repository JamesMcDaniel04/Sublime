/**
 * Named dashboard layouts assigned to goal templates. Six presets rather than
 * 45 bespoke layouts — the shapes that matter are "money going up", "money
 * going down", "a rate", "a count", "personal", and "an org goal with
 * children".
 *
 * Single-metric widgets only: the wizard binds exactly one metric, so
 * `comparison` and `ratio` (which need 2+) are excluded by construction and
 * by test. `narrative` is excluded too — its config requires prose, and canned
 * copy on every templated dashboard reads as filler.
 *
 * Widget ids are preset-scoped and stable so parseDraftLayout's duplicate-id
 * skip never fires.
 */
import type { DashboardLayout, WidgetType } from './dashboard'

const preset = (name: string, order: WidgetType[]): DashboardLayout => ({
  version: 1,
  widgets: order.map((type) => ({ id: `${name}-${type}`, type, config: {} })),
})

/** Revenue, ARR, MRR, quota — the number should climb and peers matter. */
export const REVENUE_LAYOUT = preset('revenue', [
  'kpi', 'trend', 'periods', 'benchmark', 'impact', 'contributions', 'history',
])

/** Savings and spend reduction — progress toward a floor, not a ceiling. */
export const COST_LAYOUT = preset('cost', [
  'kpi', 'progress', 'trend', 'impact', 'contributions', 'history',
])

/** Percentage KPIs — rates have no meaningful "progress bar" story. */
export const RATE_LAYOUT = preset('rate', [
  'kpi', 'trend', 'benchmark', 'periods', 'history',
])

/** Count KPIs and lead gen. */
export const COUNT_LAYOUT = preset('count', [
  'kpi', 'progress', 'trend', 'periods', 'contributions', 'history',
])

/** Personal-scope goals: no rollups (no children) and no benchmark
 *  (peer data is org-level). */
export const PERSONAL_LAYOUT = preset('personal', [
  'kpi', 'progress', 'trend', 'periods', 'history',
])

/** Org goals expected to have personal goals rolling up into them. */
export const ORG_ROLLUP_LAYOUT = preset('org-rollup', [
  'kpi', 'trend', 'rollups', 'periods', 'benchmark', 'impact', 'contributions', 'history',
])

export const GOAL_TEMPLATE_LAYOUTS = {
  REVENUE_LAYOUT,
  COST_LAYOUT,
  RATE_LAYOUT,
  COUNT_LAYOUT,
  PERSONAL_LAYOUT,
  ORG_ROLLUP_LAYOUT,
} as const
