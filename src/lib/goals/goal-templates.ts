/**
 * Static goal-template catalogue: per served department, 2 org + 2 personal
 * starting points. Pure data — selecting one prefills the wizard
 * (`/goals/new?template=<key>`); target value and metric source always
 * remain the user's. Invariants (4 per department, 2/2 scope split, valid
 * kinds) are locked by goal-templates.test.ts.
 */
import type { GoalSummary } from '@/lib/types'
import { GOAL_KIND_UNITS } from '@/lib/types'
import type { Department } from '@/lib/templates/departments'

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
}

const template = (
  key: string,
  department: GoalTemplate['department'],
  scope: GoalTemplate['scope'],
  name: string,
  description: string,
  kind: GoalSummary['kind'],
  options: Partial<Pick<GoalTemplate, 'direction' | 'unit' | 'recurrence'>> = {},
): GoalTemplate => ({
  key,
  department,
  scope,
  name,
  description,
  kind,
  direction: options.direction ?? (kind === 'savings' ? 'decrease' : 'increase'),
  unit: options.unit ?? GOAL_KIND_UNITS[kind] ?? 'count',
  recurrence:
    options.recurrence !== undefined
      ? options.recurrence
      : kind === 'quota'
        ? 'quarterly'
        : kind === 'mrr' || kind === 'lead_gen'
          ? 'monthly'
          : null,
})

export const GOAL_TEMPLATES: GoalTemplate[] = [
  // ── Sales ────────────────────────────────────────────────────────────────
  template('sales-org-quarterly-revenue', 'sales', 'org', 'Quarterly revenue target', 'Track closed-won revenue against the number the team committed to.', 'revenue', { recurrence: 'quarterly' }),
  template('sales-org-arr-growth', 'sales', 'org', 'Grow ARR', 'The company-level recurring-revenue target, tracked from your billing source of truth.', 'arr'),
  template('sales-personal-quota', 'sales', 'personal', 'Hit my quarterly quota', 'Your own attainment against quota, refreshed from CRM closed-won.', 'quota'),
  template('sales-personal-monthly-closed', 'sales', 'personal', 'Close more revenue this month', 'A personal monthly closed-won target that resets every cycle.', 'revenue', { recurrence: 'monthly' }),
  // ── Marketing ───────────────────────────────────────────────────────────
  template('marketing-org-monthly-mqls', 'marketing', 'org', 'Monthly qualified leads', 'Lead generation against a monthly MQL target from your CRM or spreadsheet.', 'lead_gen'),
  template('marketing-org-inbound-mrr', 'marketing', 'org', 'Grow inbound-sourced MRR', 'Recurring revenue attributed to marketing-sourced pipeline.', 'mrr'),
  template('marketing-personal-campaign-leads', 'marketing', 'personal', 'Leads from my campaigns', 'A personal lead target for the campaigns you own this month.', 'lead_gen'),
  template('marketing-personal-newsletter', 'marketing', 'personal', 'Grow newsletter signups', 'Signups tracked from your list tool, a sheet, or a dashboard URL.', 'custom_kpi', { unit: 'count', recurrence: 'monthly' }),
  // ── Engineering ─────────────────────────────────────────────────────────
  template('engineering-org-infra-savings', 'engineering', 'org', 'Cut infrastructure spend', 'A cost-reduction target — the trendline should go DOWN.', 'savings', { recurrence: 'quarterly' }),
  template('engineering-org-open-bugs', 'engineering', 'org', 'Reduce open bug count', 'Drive the open-defect count down and keep it down.', 'custom_kpi', { unit: 'count', direction: 'decrease' }),
  template('engineering-personal-bug-backlog', 'engineering', 'personal', 'Clear my bug backlog', 'Your personally-assigned open issues, trending to a target.', 'custom_kpi', { unit: 'count', direction: 'decrease' }),
  template('engineering-personal-ship-cadence', 'engineering', 'personal', 'Ship N releases this quarter', 'A personal shipping-cadence target for the quarter.', 'custom_kpi', { unit: 'count', recurrence: 'quarterly' }),
  // ── Finance ─────────────────────────────────────────────────────────────
  template('finance-org-vendor-savings', 'finance', 'org', 'Reduce vendor spend', 'A company savings target across renegotiated and retired vendors.', 'savings'),
  template('finance-org-collected-revenue', 'finance', 'org', 'Collected-revenue target', 'Cash actually collected, not just booked — tracked from your ledger.', 'revenue', { recurrence: 'quarterly' }),
  template('finance-personal-cost-center', 'finance', 'personal', 'Cut my cost center spend', 'A personal savings target for the budget lines you own.', 'savings'),
  template('finance-personal-dso', 'finance', 'personal', 'Bring DSO down', 'Days sales outstanding, trending down toward a target.', 'custom_kpi', { unit: 'count', direction: 'decrease' }),
  // ── CSM ─────────────────────────────────────────────────────────────────
  template('csm-org-nrr', 'csm', 'org', 'Net revenue retention', 'NRR as a percentage target — the health metric of the book.', 'custom_kpi', { unit: 'percent' }),
  template('csm-org-expansion-mrr', 'csm', 'org', 'Grow expansion MRR', 'Upsell and expansion recurring revenue, tracked monthly.', 'mrr'),
  template('csm-personal-renewals', 'csm', 'personal', 'Renewals closed this quarter', 'Your renewal revenue against the quarter’s book.', 'revenue', { recurrence: 'quarterly' }),
  template('csm-personal-churn-saves', 'csm', 'personal', 'Reduce churned accounts', 'Accounts lost from your book, trending down.', 'custom_kpi', { unit: 'count', direction: 'decrease' }),
]

export function goalTemplateByKey(key: string): GoalTemplate | null {
  return GOAL_TEMPLATES.find((entry) => entry.key === key) ?? null
}
