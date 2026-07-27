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
  /** Curated seedKeys from this template's own department that work toward
   *  this goal. Explicitly `[]` when no existing seed genuinely fits — the
   *  bundle then falls back to kind-matching. Required so an omission is a
   *  compile error rather than an invisible gap. */
  agents: string[]
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
  /** Required, may be `[]`. See GoalTemplate.agents. */
  agents: string[]
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
  agents: spec.agents,
  layout: spec.layout,
})

export const GOAL_TEMPLATES: GoalTemplate[] = [
  // ── Sales ────────────────────────────────────────────────────────────────
  template('sales-org-quarterly-revenue', 'sales', 'org', 'Quarterly revenue target', 'Track closed-won revenue against the number the team committed to.', 'revenue', {
    category: 'Revenue', recurrence: 'quarterly', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Closed-won revenue for the current quarter, re-read every few hours.',
    sources: ['stripe', 'hubspot', 'salesforce', 'google_sheets'],
    agents: ['sales-forecast-evidence-auditor', 'sales-weekly-pipeline-digest'],
  }),
  template('sales-org-arr-growth', 'sales', 'org', 'Grow ARR', 'The company-level recurring-revenue target, tracked from your billing source of truth.', 'arr', {
    category: 'Revenue', layout: REVENUE_LAYOUT,
    tracks: 'Total annual recurring revenue as your billing system reports it.',
    sources: ['stripe', 'postgres', 'google_sheets'],
    agents: ['sales-renewal-expansion-radar'],
  }),
  template('sales-personal-quota', 'sales', 'personal', 'Hit my quarterly quota', 'Your own attainment against quota, refreshed from CRM closed-won.', 'quota', {
    category: 'Revenue', layout: PERSONAL_LAYOUT,
    tracks: 'Closed-won revenue attributed to you this quarter.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
    agents: ['sales-forecast-evidence-auditor', 'sales-prospect-followup-digest'],
  }),
  template('sales-personal-monthly-closed', 'sales', 'personal', 'Close more revenue this month', 'A personal monthly closed-won target that resets every cycle.', 'revenue', {
    category: 'Revenue', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Your closed-won revenue for the current month.',
    sources: ['hubspot', 'salesforce', 'stripe', 'google_sheets'],
    agents: ['sales-discovery-followup-writer', 'sales-prospect-followup-digest'],
  }),
  template('sales-org-pipeline-coverage', 'sales', 'org', 'Pipeline coverage ratio', 'Open pipeline as a multiple of the number you have to close — the earliest warning you get.', 'custom_kpi', {
    category: 'Pipeline', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Open pipeline value divided by remaining quota, as a percentage.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
    agents: ['sales-pipeline-hygiene-nudger', 'sales-territory-white-space'],
  }),
  template('sales-org-win-rate', 'sales', 'org', 'Improve win rate', 'The share of qualified opportunities that close won.', 'custom_kpi', {
    category: 'Pipeline', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Closed-won opportunities as a percentage of all closed opportunities.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
    agents: ['sales-loss-pattern-review', 'sales-call-coaching-loop'],
  }),
  template('sales-org-new-logos', 'sales', 'org', 'New logos this quarter', 'Net-new customer accounts, counted rather than valued.', 'custom_kpi', {
    category: 'Pipeline', unit: 'count', recurrence: 'quarterly', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Accounts that became customers for the first time this quarter.',
    sources: ['hubspot', 'salesforce', 'stripe', 'google_sheets'],
    agents: ['sales-territory-white-space', 'sales-new-lead-to-sf-opportunity'],
  }),
  template('sales-personal-pipeline-created', 'sales', 'personal', 'Pipeline I created', 'New qualified pipeline you sourced this month, ahead of anything closing.', 'revenue', {
    category: 'Pipeline', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Value of qualified opportunities you created this month.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
    agents: ['sales-sequence-personalizer', 'sales-account-intent-brief'],
  }),
  template('sales-personal-meetings-booked', 'sales', 'personal', 'Meetings booked this month', 'The activity number upstream of everything else.', 'custom_kpi', {
    category: 'Pipeline', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Discovery or demo meetings you booked this month.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
    agents: ['sales-sequence-personalizer', 'sales-prospect-followup-digest'],
  }),
  // ── Marketing ───────────────────────────────────────────────────────────
  template('marketing-org-monthly-mqls', 'marketing', 'org', 'Monthly qualified leads', 'Lead generation against a monthly MQL target from your CRM or spreadsheet.', 'lead_gen', {
    category: 'Demand', layout: COUNT_LAYOUT,
    tracks: 'Count of leads that crossed your MQL threshold this month.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
    agents: ['mkt-inbound-mql-router', 'marketing-lead-quality-loop'],
  }),
  template('marketing-org-inbound-mrr', 'marketing', 'org', 'Grow inbound-sourced MRR', 'Recurring revenue attributed to marketing-sourced pipeline.', 'mrr', {
    category: 'Revenue', layout: REVENUE_LAYOUT,
    tracks: 'Monthly recurring revenue on accounts whose first touch was inbound.',
    sources: ['hubspot', 'stripe', 'postgres', 'google_sheets'],
    agents: ['marketing-lead-quality-loop', 'marketing-funnel-anomaly-brief'],
  }),
  template('marketing-personal-campaign-leads', 'marketing', 'personal', 'Leads from my campaigns', 'A personal lead target for the campaigns you own this month.', 'lead_gen', {
    category: 'Demand', layout: PERSONAL_LAYOUT,
    tracks: 'Leads attributed to campaigns you own, this month.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
    agents: ['mkt-inbound-mql-router', 'marketing-campaign-command-center'],
  }),
  template('marketing-personal-newsletter', 'marketing', 'personal', 'Grow newsletter signups', 'Signups tracked from your list tool, a sheet, or a dashboard URL.', 'custom_kpi', {
    category: 'Demand', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Total list subscribers, read from your list tool or a sheet.',
    sources: ['google_sheets', 'url', 'hubspot'],
    agents: [],
  }),
  template('marketing-org-cac', 'marketing', 'org', 'Bring CAC down', 'Blended cost to acquire a customer — spend divided by new customers.', 'savings', {
    category: 'Cost', layout: COST_LAYOUT,
    tracks: 'Total acquisition spend divided by new customers, per period.',
    sources: ['postgres', 'google_sheets', 'hubspot'],
    agents: ['marketing-funnel-anomaly-brief', 'marketing-lead-quality-loop'],
  }),
  template('marketing-org-organic-traffic', 'marketing', 'org', 'Grow organic traffic', 'Non-paid sessions, the compounding channel.', 'custom_kpi', {
    category: 'Demand', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    tracks: 'Organic sessions this month, read from analytics or a sheet.',
    sources: ['google_sheets', 'url', 'postgres'],
    agents: ['marketing-content-repurpose-engine', 'marketing-editorial-operations'],
  }),
  template('marketing-org-sourced-pipeline', 'marketing', 'org', 'Marketing-sourced pipeline', 'Pipeline value attributed to marketing first-touch, not just lead count.', 'revenue', {
    category: 'Pipeline', recurrence: 'quarterly', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Value of open opportunities whose first touch was marketing.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
    agents: ['marketing-lead-quality-loop', 'marketing-funnel-anomaly-brief'],
  }),
  template('marketing-personal-content-output', 'marketing', 'personal', 'Ship N pieces this month', 'A personal publishing cadence — the input you actually control.', 'custom_kpi', {
    category: 'Demand', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Pieces you published this month.',
    sources: ['google_sheets', 'url'],
    agents: ['marketing-editorial-operations', 'mkt-content-repurposer'],
  }),
  template('marketing-personal-conversion-rate', 'marketing', 'personal', 'Lift my landing conversion', 'The conversion rate on the pages you own.', 'custom_kpi', {
    category: 'Demand', unit: 'percent', layout: PERSONAL_LAYOUT,
    tracks: 'Conversions as a percentage of visits on your pages.',
    sources: ['google_sheets', 'url', 'postgres'],
    agents: ['marketing-creative-performance-review', 'marketing-funnel-anomaly-brief'],
  }),
  // ── Engineering ─────────────────────────────────────────────────────────
  template('engineering-org-infra-savings', 'engineering', 'org', 'Cut infrastructure spend', 'A cost-reduction target — the trendline should go DOWN.', 'savings', {
    category: 'Cost', recurrence: 'quarterly', layout: COST_LAYOUT,
    tracks: 'Monthly cloud and infrastructure spend, trending toward your floor.',
    sources: ['postgres', 'google_sheets', 'url'],
    agents: [],
  }),
  template('engineering-org-open-bugs', 'engineering', 'org', 'Reduce open bug count', 'Drive the open-defect count down and keep it down.', 'custom_kpi', {
    category: 'Quality', unit: 'count', direction: 'decrease', layout: COUNT_LAYOUT,
    tracks: 'Open defects across the tracker, counted on every sync.',
    sources: ['postgres', 'google_sheets', 'url'],
    agents: ['eng-quality-escape-review', 'eng-issue-triage-routing'],
  }),
  template('engineering-personal-bug-backlog', 'engineering', 'personal', 'Clear my bug backlog', 'Your personally-assigned open issues, trending to a target.', 'custom_kpi', {
    category: 'Quality', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Open issues assigned to you.',
    sources: ['postgres', 'google_sheets', 'url'],
    agents: ['eng-issue-triage-routing'],
  }),
  template('engineering-personal-ship-cadence', 'engineering', 'personal', 'Ship N releases this quarter', 'A personal shipping-cadence target for the quarter.', 'custom_kpi', {
    category: 'Delivery', unit: 'count', recurrence: 'quarterly', layout: PERSONAL_LAYOUT,
    tracks: 'Releases you shipped this quarter.',
    sources: ['postgres', 'google_sheets'],
    agents: ['eng-sprint-risk-forecaster'],
  }),
  template('engineering-org-deploy-frequency', 'engineering', 'org', 'Deploy more often', 'Deployment frequency — the DORA metric that moves everything else.', 'custom_kpi', {
    category: 'Delivery', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    tracks: 'Production deployments this month.',
    sources: ['postgres', 'google_sheets', 'url'],
    agents: ['eng-release-readiness-room', 'eng-release-notes-drafter'],
  }),
  template('engineering-org-p1-incidents', 'engineering', 'org', 'Cut Sev-1 incidents', 'The count of the incidents that wake people up.', 'custom_kpi', {
    category: 'Quality', unit: 'count', direction: 'decrease', recurrence: 'quarterly', layout: COUNT_LAYOUT,
    tracks: 'Severity-1 incidents declared this quarter.',
    sources: ['postgres', 'google_sheets', 'slack_assisted'],
    agents: ['eng-incident-context-assembler', 'eng-oncall-handoff'],
  }),
  template('engineering-org-lead-time', 'engineering', 'org', 'Shorten lead time to production', 'Hours from first commit to running in production.', 'custom_kpi', {
    category: 'Delivery', unit: 'count', direction: 'decrease', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Median hours from first commit to production deploy.',
    sources: ['postgres', 'google_sheets'],
    agents: ['eng-sprint-risk-forecaster', 'eng-pr-review-checklist-bot'],
  }),
  template('engineering-personal-review-turnaround', 'engineering', 'personal', 'Review PRs faster', 'Hours between a review being requested of you and you giving it.', 'custom_kpi', {
    category: 'Delivery', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Median hours you take to respond to a review request.',
    sources: ['postgres', 'google_sheets'],
    agents: ['eng-pr-review-checklist-bot'],
  }),
  template('engineering-personal-test-coverage', 'engineering', 'personal', 'Raise coverage on my services', 'Line coverage on the services you own.', 'custom_kpi', {
    category: 'Quality', unit: 'percent', layout: PERSONAL_LAYOUT,
    tracks: 'Line coverage percentage on your services, from CI output.',
    sources: ['url', 'google_sheets', 'postgres'],
    agents: ['eng-quality-escape-review'],
  }),
  // ── Finance ─────────────────────────────────────────────────────────────
  template('finance-org-vendor-savings', 'finance', 'org', 'Reduce vendor spend', 'A company savings target across renegotiated and retired vendors.', 'savings', {
    category: 'Cost', layout: COST_LAYOUT,
    tracks: 'Total vendor spend across the ledger, trending down.',
    sources: ['postgres', 'google_sheets'],
    agents: ['finance-spend-exception-review', 'fin-spend-anomaly-reporter'],
  }),
  template('finance-org-collected-revenue', 'finance', 'org', 'Collected-revenue target', 'Cash actually collected, not just booked — tracked from your ledger.', 'revenue', {
    category: 'Revenue', recurrence: 'quarterly', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Cash received this quarter, not invoiced amounts.',
    sources: ['stripe', 'postgres', 'google_sheets'],
    agents: ['finance-cash-collection-prioritizer', 'fin-weekly-cash-ar-digest'],
  }),
  template('finance-personal-cost-center', 'finance', 'personal', 'Cut my cost center spend', 'A personal savings target for the budget lines you own.', 'savings', {
    category: 'Cost', layout: PERSONAL_LAYOUT,
    tracks: 'Spend on the budget lines you own.',
    sources: ['postgres', 'google_sheets'],
    agents: ['finance-spend-exception-review'],
  }),
  template('finance-personal-dso', 'finance', 'personal', 'Bring DSO down', 'Days sales outstanding, trending down toward a target.', 'custom_kpi', {
    category: 'Cost', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Average days between invoice and payment across your accounts.',
    sources: ['postgres', 'stripe', 'google_sheets'],
    agents: ['finance-cash-collection-prioritizer', 'fin-weekly-cash-ar-digest'],
  }),
  template('finance-org-gross-margin', 'finance', 'org', 'Improve gross margin', 'Revenue less cost of revenue, as a percentage.', 'custom_kpi', {
    category: 'Cost', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Gross profit as a percentage of revenue, from the ledger.',
    sources: ['postgres', 'google_sheets', 'stripe'],
    agents: ['finance-margin-leakage-finder', 'finance-deal-economics-review'],
  }),
  template('finance-org-burn-reduction', 'finance', 'org', 'Reduce monthly burn', 'Net cash out per month, trending toward a floor.', 'savings', {
    category: 'Cost', recurrence: 'monthly', layout: COST_LAYOUT,
    tracks: 'Net cash consumed this month.',
    sources: ['postgres', 'google_sheets', 'stripe'],
    agents: ['fin-spend-anomaly-reporter', 'finance-headcount-plan-monitor'],
  }),
  template('finance-org-revenue-per-head', 'finance', 'org', 'Revenue per employee', 'The efficiency number the board asks about.', 'custom_kpi', {
    category: 'Revenue', unit: 'usd', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Trailing revenue divided by headcount.',
    sources: ['postgres', 'google_sheets', 'stripe'],
    agents: ['finance-headcount-plan-monitor', 'finance-board-metrics-packet'],
  }),
  template('finance-personal-close-cycle', 'finance', 'personal', 'Close the books faster', 'Business days from period end to a closed set of books.', 'custom_kpi', {
    category: 'Delivery', unit: 'count', direction: 'decrease', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Business days taken to close the most recent period.',
    sources: ['google_sheets', 'postgres'],
    agents: ['finance-close-command-center'],
  }),
  template('finance-personal-forecast-accuracy', 'finance', 'personal', 'Tighten my forecast accuracy', 'How close your forecast lands to the actual, as a percentage.', 'custom_kpi', {
    category: 'Quality', unit: 'percent', recurrence: 'quarterly', layout: PERSONAL_LAYOUT,
    tracks: 'Actual divided by forecast for the closed period, as a percentage.',
    sources: ['google_sheets', 'postgres', 'salesforce'],
    agents: ['finance-forecast-assumption-register', 'finance-revenue-variance-explainer'],
  }),
  // ── CSM ─────────────────────────────────────────────────────────────────
  template('csm-org-nrr', 'csm', 'org', 'Net revenue retention', 'NRR as a percentage target — the health metric of the book.', 'custom_kpi', {
    category: 'Retention', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Revenue from existing accounts versus the same cohort a year ago.',
    sources: ['stripe', 'hubspot', 'salesforce', 'postgres'],
    agents: ['csm-renewal-readiness-review', 'csm-churn-risk-early-warning'],
  }),
  template('csm-org-expansion-mrr', 'csm', 'org', 'Grow expansion MRR', 'Upsell and expansion recurring revenue, tracked monthly.', 'mrr', {
    category: 'Revenue', layout: REVENUE_LAYOUT,
    tracks: 'Recurring revenue added by upsells on existing accounts this month.',
    sources: ['stripe', 'hubspot', 'salesforce', 'postgres'],
    agents: ['csm-adoption-gap-finder', 'csm-renewal-readiness-review'],
  }),
  template('csm-personal-renewals', 'csm', 'personal', 'Renewals closed this quarter', 'Your renewal revenue against the quarter’s book.', 'revenue', {
    category: 'Retention', recurrence: 'quarterly', layout: PERSONAL_LAYOUT,
    tracks: 'Renewal revenue you closed this quarter.',
    sources: ['hubspot', 'salesforce', 'stripe', 'google_sheets'],
    agents: ['csm-renewal-readiness-review', 'csm-renewal-risk-email'],
  }),
  template('csm-personal-churn-saves', 'csm', 'personal', 'Reduce churned accounts', 'Accounts lost from your book, trending down.', 'custom_kpi', {
    category: 'Retention', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Accounts lost from your book this period.',
    sources: ['hubspot', 'salesforce', 'postgres', 'google_sheets'],
    agents: ['csm-churn-risk-early-warning', 'csm-escalation-command-center'],
  }),
  template('csm-org-gross-retention', 'csm', 'org', 'Gross revenue retention', 'Retention before any expansion — the honest churn number.', 'custom_kpi', {
    category: 'Retention', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Retained revenue from the starting cohort, excluding upsell.',
    sources: ['stripe', 'hubspot', 'salesforce', 'postgres'],
    agents: ['csm-churn-risk-early-warning', 'csm-health-score-explainer'],
  }),
  template('csm-org-csat', 'csm', 'org', 'Raise CSAT', 'Satisfaction score across the accounts you serve.', 'custom_kpi', {
    category: 'Retention', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Average satisfaction score across responses this period.',
    sources: ['google_sheets', 'postgres', 'url'],
    agents: ['csm-ticket-theme-to-roadmap', 'csm-escalation-command-center'],
  }),
  template('csm-org-time-to-value', 'csm', 'org', 'Shorten time to first value', 'Days from signature to the customer getting their first real outcome.', 'custom_kpi', {
    category: 'Retention', unit: 'count', direction: 'decrease', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Median days from close to first activation milestone.',
    sources: ['postgres', 'hubspot', 'salesforce', 'google_sheets'],
    agents: ['csm-onboarding-task-orchestrator', 'csm-onboarding-risk-radar'],
  }),
  template('csm-personal-qbr-coverage', 'csm', 'personal', 'QBR coverage of my book', 'The share of your accounts that got a real business review this quarter.', 'custom_kpi', {
    category: 'Retention', unit: 'percent', recurrence: 'quarterly', layout: PERSONAL_LAYOUT,
    tracks: 'Accounts with a completed QBR as a percentage of your book.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
    agents: ['csm-qbr-prep-brief', 'csm-executive-briefing'],
  }),
  template('csm-personal-response-time', 'csm', 'personal', 'Respond to my accounts faster', 'Hours between a customer reaching out and you replying.', 'custom_kpi', {
    category: 'Quality', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Median hours to your first reply on inbound account messages.',
    sources: ['postgres', 'gmail_assisted', 'google_sheets'],
    agents: ['csm-ticket-triage-escalation', 'csm-escalation-command-center'],
  }),
]

export function goalTemplateByKey(key: string): GoalTemplate | null {
  return GOAL_TEMPLATES.find((entry) => entry.key === key) ?? null
}
