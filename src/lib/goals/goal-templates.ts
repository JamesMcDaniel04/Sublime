/**
 * Static goal-template catalogue: 9 per served department, 5 org + 4 personal.
 * Pure data — selecting one prefills the wizard (`/goals/new?template=<key>`)
 * including its dashboard layout; target value and metric source always remain
 * the user's. Invariants (per-department counts, valid kinds, valid sources,
 * single-metric layouts, key preservation) are locked by goal-templates.test.ts.
 */
import type { GoalSummary } from '@/lib/types'
import { GOAL_KIND_UNITS } from '@/lib/types'
import type { Department } from '@/lib/templates/departments'
import type { MetricSource } from '@/lib/goals/metric-sources'
import type { DashboardLayout } from '@/lib/goals/dashboard'
import {
  COST_LAYOUT,
  COUNT_LAYOUT,
  ORG_ROLLUP_LAYOUT,
  PERSONAL_LAYOUT,
  RATE_LAYOUT,
  REVENUE_LAYOUT,
} from '@/lib/goals/goal-template-layouts'

/** Closed union so every category maps to exactly one accent and icon. */
export const GOAL_TEMPLATE_CATEGORIES = [
  'Revenue',
  'Pipeline',
  'Cost',
  'Retention',
  'Delivery',
  'Quality',
  'Demand',
] as const
export type GoalTemplateCategory = (typeof GOAL_TEMPLATE_CATEGORIES)[number]

export type GoalTemplate = {
  key: string
  department: Exclude<Department, 'general'>
  scope: 'org' | 'personal'
  name: string
  description: string
  kind: GoalSummary['kind']
  direction: 'increase' | 'decrease'
  /** Only meaningful for custom_kpi (other kinds derive from the kind). */
  unit: GoalSummary['unit']
  recurrence: 'monthly' | 'quarterly' | 'yearly' | null
  /** Drives the card's accent and icon. */
  category: GoalTemplateCategory
  /** One sentence: what number is actually read, and how often. */
  tracks: string
  /** Ranked metric sources, best first. `manual` is always appended last. */
  sources: MetricSource[]
  /** Draft-form layout (metric-index refs), single-metric widgets only. */
  layout: DashboardLayout
}

/** Rank, dedupe, and guarantee `manual` as the last resort. */
const rankSources = (sources: MetricSource[]): MetricSource[] => [
  ...sources.filter(
    (source, index) => source !== 'manual' && sources.indexOf(source) === index,
  ),
  'manual',
]

type TemplateSpec = {
  category: GoalTemplateCategory
  tracks: string
  sources: MetricSource[]
  layout: DashboardLayout
  direction?: GoalTemplate['direction']
  unit?: GoalTemplate['unit']
  recurrence?: GoalTemplate['recurrence']
}

const template = (
  key: string,
  department: GoalTemplate['department'],
  scope: GoalTemplate['scope'],
  name: string,
  description: string,
  kind: GoalSummary['kind'],
  spec: TemplateSpec,
): GoalTemplate => ({
  key,
  department,
  scope,
  name,
  description,
  kind,
  direction: spec.direction ?? (kind === 'savings' ? 'decrease' : 'increase'),
  unit: spec.unit ?? GOAL_KIND_UNITS[kind] ?? 'count',
  recurrence:
    spec.recurrence !== undefined
      ? spec.recurrence
      : kind === 'quota'
        ? 'quarterly'
        : kind === 'mrr' || kind === 'lead_gen'
          ? 'monthly'
          : null,
  category: spec.category,
  tracks: spec.tracks,
  sources: rankSources(spec.sources),
  layout: spec.layout,
})

export const GOAL_TEMPLATES: GoalTemplate[] = [
  // ── Sales ────────────────────────────────────────────────────────────────
  template('sales-org-quarterly-revenue', 'sales', 'org', 'Quarterly revenue target', 'Track closed-won revenue against the number the team committed to.', 'revenue', {
    category: 'Revenue', recurrence: 'quarterly', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Closed-won revenue for the current quarter, re-read every few hours.',
    sources: ['stripe', 'hubspot', 'salesforce', 'google_sheets'],
  }),
  template('sales-org-arr-growth', 'sales', 'org', 'Grow ARR', 'The company-level recurring-revenue target, tracked from your billing source of truth.', 'arr', {
    category: 'Revenue', layout: REVENUE_LAYOUT,
    tracks: 'Total annual recurring revenue as your billing system reports it.',
    sources: ['stripe', 'postgres', 'google_sheets'],
  }),
  template('sales-personal-quota', 'sales', 'personal', 'Hit my quarterly quota', 'Your own attainment against quota, refreshed from CRM closed-won.', 'quota', {
    category: 'Revenue', layout: PERSONAL_LAYOUT,
    tracks: 'Closed-won revenue attributed to you this quarter.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
  }),
  template('sales-personal-monthly-closed', 'sales', 'personal', 'Close more revenue this month', 'A personal monthly closed-won target that resets every cycle.', 'revenue', {
    category: 'Revenue', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Your closed-won revenue for the current month.',
    sources: ['hubspot', 'salesforce', 'stripe', 'google_sheets'],
  }),
  // ── Marketing ───────────────────────────────────────────────────────────
  template('marketing-org-monthly-mqls', 'marketing', 'org', 'Monthly qualified leads', 'Lead generation against a monthly MQL target from your CRM or spreadsheet.', 'lead_gen', {
    category: 'Demand', layout: COUNT_LAYOUT,
    tracks: 'Count of leads that crossed your MQL threshold this month.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
  }),
  template('marketing-org-inbound-mrr', 'marketing', 'org', 'Grow inbound-sourced MRR', 'Recurring revenue attributed to marketing-sourced pipeline.', 'mrr', {
    category: 'Revenue', layout: REVENUE_LAYOUT,
    tracks: 'Monthly recurring revenue on accounts whose first touch was inbound.',
    sources: ['hubspot', 'stripe', 'postgres', 'google_sheets'],
  }),
  template('marketing-personal-campaign-leads', 'marketing', 'personal', 'Leads from my campaigns', 'A personal lead target for the campaigns you own this month.', 'lead_gen', {
    category: 'Demand', layout: PERSONAL_LAYOUT,
    tracks: 'Leads attributed to campaigns you own, this month.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
  }),
  template('marketing-personal-newsletter', 'marketing', 'personal', 'Grow newsletter signups', 'Signups tracked from your list tool, a sheet, or a dashboard URL.', 'custom_kpi', {
    category: 'Demand', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Total list subscribers, read from your list tool or a sheet.',
    sources: ['google_sheets', 'url', 'hubspot'],
  }),
  // ── Engineering ─────────────────────────────────────────────────────────
  template('engineering-org-infra-savings', 'engineering', 'org', 'Cut infrastructure spend', 'A cost-reduction target — the trendline should go DOWN.', 'savings', {
    category: 'Cost', recurrence: 'quarterly', layout: COST_LAYOUT,
    tracks: 'Monthly cloud and infrastructure spend, trending toward your floor.',
    sources: ['postgres', 'google_sheets', 'url'],
  }),
  template('engineering-org-open-bugs', 'engineering', 'org', 'Reduce open bug count', 'Drive the open-defect count down and keep it down.', 'custom_kpi', {
    category: 'Quality', unit: 'count', direction: 'decrease', layout: COUNT_LAYOUT,
    tracks: 'Open defects across the tracker, counted on every sync.',
    sources: ['postgres', 'google_sheets', 'url'],
  }),
  template('engineering-personal-bug-backlog', 'engineering', 'personal', 'Clear my bug backlog', 'Your personally-assigned open issues, trending to a target.', 'custom_kpi', {
    category: 'Quality', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Open issues assigned to you.',
    sources: ['postgres', 'google_sheets', 'url'],
  }),
  template('engineering-personal-ship-cadence', 'engineering', 'personal', 'Ship N releases this quarter', 'A personal shipping-cadence target for the quarter.', 'custom_kpi', {
    category: 'Delivery', unit: 'count', recurrence: 'quarterly', layout: PERSONAL_LAYOUT,
    tracks: 'Releases you shipped this quarter.',
    sources: ['postgres', 'google_sheets'],
  }),
  // ── Finance ─────────────────────────────────────────────────────────────
  template('finance-org-vendor-savings', 'finance', 'org', 'Reduce vendor spend', 'A company savings target across renegotiated and retired vendors.', 'savings', {
    category: 'Cost', layout: COST_LAYOUT,
    tracks: 'Total vendor spend across the ledger, trending down.',
    sources: ['postgres', 'google_sheets'],
  }),
  template('finance-org-collected-revenue', 'finance', 'org', 'Collected-revenue target', 'Cash actually collected, not just booked — tracked from your ledger.', 'revenue', {
    category: 'Revenue', recurrence: 'quarterly', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Cash received this quarter, not invoiced amounts.',
    sources: ['stripe', 'postgres', 'google_sheets'],
  }),
  template('finance-personal-cost-center', 'finance', 'personal', 'Cut my cost center spend', 'A personal savings target for the budget lines you own.', 'savings', {
    category: 'Cost', layout: PERSONAL_LAYOUT,
    tracks: 'Spend on the budget lines you own.',
    sources: ['postgres', 'google_sheets'],
  }),
  template('finance-personal-dso', 'finance', 'personal', 'Bring DSO down', 'Days sales outstanding, trending down toward a target.', 'custom_kpi', {
    category: 'Cost', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Average days between invoice and payment across your accounts.',
    sources: ['postgres', 'stripe', 'google_sheets'],
  }),
  // ── CSM ─────────────────────────────────────────────────────────────────
  template('csm-org-nrr', 'csm', 'org', 'Net revenue retention', 'NRR as a percentage target — the health metric of the book.', 'custom_kpi', {
    category: 'Retention', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Revenue from existing accounts versus the same cohort a year ago.',
    sources: ['stripe', 'hubspot', 'salesforce', 'postgres'],
  }),
  template('csm-org-expansion-mrr', 'csm', 'org', 'Grow expansion MRR', 'Upsell and expansion recurring revenue, tracked monthly.', 'mrr', {
    category: 'Revenue', layout: REVENUE_LAYOUT,
    tracks: 'Recurring revenue added by upsells on existing accounts this month.',
    sources: ['stripe', 'hubspot', 'salesforce', 'postgres'],
  }),
  template('csm-personal-renewals', 'csm', 'personal', 'Renewals closed this quarter', 'Your renewal revenue against the quarter’s book.', 'revenue', {
    category: 'Retention', recurrence: 'quarterly', layout: PERSONAL_LAYOUT,
    tracks: 'Renewal revenue you closed this quarter.',
    sources: ['hubspot', 'salesforce', 'stripe', 'google_sheets'],
  }),
  template('csm-personal-churn-saves', 'csm', 'personal', 'Reduce churned accounts', 'Accounts lost from your book, trending down.', 'custom_kpi', {
    category: 'Retention', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Accounts lost from your book this period.',
    sources: ['hubspot', 'salesforce', 'postgres', 'google_sheets'],
  }),
]

export function goalTemplateByKey(key: string): GoalTemplate | null {
  return GOAL_TEMPLATES.find((entry) => entry.key === key) ?? null
}
