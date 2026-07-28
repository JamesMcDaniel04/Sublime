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
  /** `action` = the number counts the agents' own output, so it lands inside
   *  AGENT_WRITABLE_SOURCES, the goal-native collector can log it, and the goal
   *  is measurable with zero integrations connected. `outcome` = a system of
   *  record owns the number and the goal is inert until one is connected. */
  motion: 'outcome' | 'action'
  /** Action only: the artifact that lands in someone's hands each cycle. This
   *  is what makes the card read as work rather than as a dashboard. */
  produces?: string
  /** Resolves through goalTemplateByKey for bookmarked links, hidden from the
   *  gallery. Deleting a key 404s a bookmark; repurposing one silently changes
   *  what that bookmark creates. Retiring does neither. */
  retired?: true
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

type BaseSpec = {
  category: GoalTemplateCategory
  tracks: string
  sources: MetricSource[]
  /** Required, may be `[]`. See GoalTemplate.agents. */
  agents: string[]
  layout: DashboardLayout
  direction?: GoalTemplate['direction']
  unit?: GoalTemplate['unit']
  recurrence?: GoalTemplate['recurrence']
  retired?: true
}

/** Discriminated so an action template that forgets `produces` is a compile
 *  error rather than a card with a missing line. */
type TemplateSpec =
  | (BaseSpec & { motion: 'outcome' })
  | (BaseSpec & { motion: 'action'; produces: string })

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
  motion: spec.motion,
  produces: spec.motion === 'action' ? spec.produces : undefined,
  retired: spec.retired,
  tracks: spec.tracks,
  sources: rankSources(spec.sources),
  agents: spec.agents,
  layout: spec.layout,
})

export const GOAL_TEMPLATES: GoalTemplate[] = [
  // ── Sales ────────────────────────────────────────────────────────────────
  template('sales-org-quarterly-revenue', 'sales', 'org', 'Quarterly revenue target', 'Track closed-won revenue against the number the team committed to.', 'revenue', {
    motion: 'outcome', category: 'Revenue', recurrence: 'quarterly', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Closed-won revenue for the current quarter, re-read every few hours.',
    sources: ['stripe', 'hubspot', 'salesforce', 'google_sheets'],
    agents: ['sales-forecast-evidence-auditor', 'sales-weekly-pipeline-digest'],
  }),
  template('sales-org-arr-growth', 'sales', 'org', 'Grow ARR', 'The company-level recurring-revenue target, tracked from your billing source of truth.', 'arr', {
    // Retired: a board metric that sits oddly in a seller's gallery. Still
    // resolves so bookmarked /goals/new?template=sales-org-arr-growth works.
    motion: 'outcome', category: 'Revenue', layout: REVENUE_LAYOUT, retired: true,
    tracks: 'Total annual recurring revenue as your billing system reports it.',
    sources: ['stripe', 'postgres', 'google_sheets'],
    agents: ['sales-renewal-expansion-radar'],
  }),
  template('sales-personal-quota', 'sales', 'personal', 'Hit my quarterly quota', 'Your own attainment against quota, refreshed from CRM closed-won.', 'quota', {
    motion: 'outcome', category: 'Revenue', layout: PERSONAL_LAYOUT,
    tracks: 'Closed-won revenue attributed to you this quarter.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
    agents: ['sales-forecast-evidence-auditor', 'sales-prospect-followup-digest'],
  }),
  template('sales-personal-monthly-closed', 'sales', 'personal', 'Close more revenue this month', 'A personal monthly closed-won target that resets every cycle.', 'revenue', {
    motion: 'outcome', category: 'Revenue', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Your closed-won revenue for the current month.',
    sources: ['hubspot', 'salesforce', 'stripe', 'google_sheets'],
    agents: ['sales-discovery-followup-writer', 'sales-prospect-followup-digest'],
  }),
  // The four org action templates trace the seller's sequence:
  // identify → qualify → engage → close.
  template('sales-org-work-the-whitespace', 'sales', 'org', 'Work the whitespace list', 'Unworked accounts get ranked and turned into a next-best play every week.', 'custom_kpi', {
    motion: 'action', category: 'Pipeline', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a ranked whitespace list with a next-best play per account',
    tracks: 'Whitespace accounts the team opened a first touch on this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['sales-territory-white-space', 'sales-account-intent-brief'],
  }),
  template('sales-org-qualify-inbound-same-day', 'sales', 'org', 'Qualify every inbound within a day', 'Every inbound lead gets scored, enriched, and routed before it goes cold.', 'custom_kpi', {
    motion: 'action', category: 'Pipeline', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a scored qualification brief and a routed owner per lead',
    tracks: 'Inbound leads qualified and routed within 24 hours this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['sales-new-lead-to-sf-opportunity', 'sales-account-intent-brief'],
  }),
  template('sales-org-multithread-open-deals', 'sales', 'org', 'Multithread every open deal', 'Every open deal gets its buying committee mapped and the missing roles worked.', 'custom_kpi', {
    motion: 'action', category: 'Pipeline', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a buying-committee map and a named intro plan per deal',
    tracks: 'Open deals brought to three or more engaged contacts this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['sales-multithreading-map', 'sales-account-intent-brief'],
  }),
  template('sales-org-close-plan-on-commit', 'sales', 'org', 'A close plan on every commit deal', 'Nothing sits in commit without an agreed path to signature.', 'custom_kpi', {
    motion: 'action', category: 'Revenue', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a mutual action plan with owners and dates, ready to send',
    tracks: 'Commit-stage deals with a customer-agreed action plan this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['sales-mutual-action-plan', 'sales-deal-desk-packet'],
  }),
  template('sales-personal-revive-stalled-deals', 'sales', 'personal', 'Revive every stalled deal', 'Deals with no touch in two weeks get a grounded re-entry, not a nudge.', 'custom_kpi', {
    motion: 'action', category: 'Pipeline', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'a re-entry email drafted from the last real conversation',
    tracks: 'Stalled deals in your book you re-engaged this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['sales-sequence-personalizer', 'sales-prospect-followup-digest'],
  }),
  template('sales-personal-followup-same-day', 'sales', 'personal', 'Follow up before the day ends', 'Every meeting turns into a follow-up that repeats what was actually committed.', 'custom_kpi', {
    motion: 'action', category: 'Pipeline', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'a follow-up recapping commitments and the next step',
    tracks: 'Meetings you followed up on the same day this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['sales-discovery-followup-writer', 'sales-prospect-followup-digest'],
  }),
  // ── Marketing ───────────────────────────────────────────────────────────
  template('marketing-org-monthly-mqls', 'marketing', 'org', 'Monthly qualified leads', 'Lead generation against a monthly MQL target from your CRM or spreadsheet.', 'lead_gen', {
    motion: 'outcome', category: 'Demand', layout: COUNT_LAYOUT,
    tracks: 'Count of leads that crossed your MQL threshold this month.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
    agents: ['mkt-inbound-mql-router', 'marketing-lead-quality-loop'],
  }),
  template('marketing-org-inbound-mrr', 'marketing', 'org', 'Grow inbound-sourced MRR', 'Recurring revenue attributed to marketing-sourced pipeline.', 'mrr', {
    motion: 'outcome', category: 'Revenue', layout: REVENUE_LAYOUT,
    tracks: 'Monthly recurring revenue on accounts whose first touch was inbound.',
    sources: ['hubspot', 'stripe', 'postgres', 'google_sheets'],
    agents: ['marketing-lead-quality-loop', 'marketing-funnel-anomaly-brief'],
  }),
  template('marketing-personal-campaign-leads', 'marketing', 'personal', 'Leads from my campaigns', 'A personal lead target for the campaigns you own this month.', 'lead_gen', {
    motion: 'outcome', category: 'Demand', layout: PERSONAL_LAYOUT,
    tracks: 'Leads attributed to campaigns you own, this month.',
    sources: ['hubspot', 'salesforce', 'google_sheets'],
    agents: ['mkt-inbound-mql-router', 'marketing-campaign-command-center'],
  }),
  template('marketing-personal-newsletter', 'marketing', 'personal', 'Grow newsletter signups', 'Signups tracked from your list tool, a sheet, or a dashboard URL.', 'custom_kpi', {
    motion: 'outcome', category: 'Demand', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Total list subscribers, read from your list tool or a sheet.',
    sources: ['google_sheets', 'url', 'hubspot'],
    agents: [],
  }),
  template('marketing-org-work-every-event-lead', 'marketing', 'org', 'Work every event lead within a week', 'Event leads get segmented, enriched, and handed to sales before they cool.', 'custom_kpi', {
    motion: 'action', category: 'Demand', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a segmented follow-up and a sales handoff per lead',
    tracks: 'Event leads followed up within a week this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['marketing-event-followup-orchestrator', 'mkt-inbound-mql-router'],
  }),
  // Kept as an outcome template on purpose: it is the only one that ranks
  // Google Analytics first, and GA4 is a fully wired connector. Removing it
  // would leave that integration with nothing in the gallery to anchor it.
  template('marketing-org-organic-traffic', 'marketing', 'org', 'Grow organic traffic', 'Non-paid sessions, the compounding channel.', 'custom_kpi', {
    motion: 'outcome', category: 'Demand', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    tracks: 'Organic sessions this month, read from analytics or a sheet.',
    sources: ['google_analytics', 'google_sheets', 'url', 'postgres'],
    agents: ['marketing-content-repurpose-engine', 'marketing-editorial-operations'],
  }),
  template('marketing-org-brief-every-launch', 'marketing', 'org', 'A readiness brief before every launch', 'No launch ships without tasks, creative, and enablement reconciled.', 'custom_kpi', {
    motion: 'action', category: 'Delivery', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a launch readiness scorecard with named blockers and owners',
    tracks: 'Launches with a completed readiness brief this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['marketing-launch-readiness', 'marketing-campaign-command-center'],
  }),
  template('marketing-personal-repurpose-every-piece', 'marketing', 'personal', 'Repurpose every piece I publish', 'One piece becomes every channel it should have been on.', 'custom_kpi', {
    motion: 'action', category: 'Demand', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'channel-specific variants with source-backed claims',
    tracks: 'Pieces you repurposed into at least one other channel this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['marketing-content-repurpose-engine', 'mkt-content-repurposer'],
  }),
  template('marketing-personal-messaging-from-customers', 'marketing', 'personal', 'Ground my messaging in customer words', 'Claims trace back to something a customer actually said.', 'custom_kpi', {
    motion: 'action', category: 'Demand', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'cited messaging themes and objections from real conversations',
    tracks: 'Messaging updates grounded in cited customer conversations this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['marketing-voice-of-customer', 'marketing-competitive-narrative'],
  }),
  // ── Engineering ─────────────────────────────────────────────────────────
  template('engineering-org-infra-savings', 'engineering', 'org', 'Cut infrastructure spend', 'A cost-reduction target — the trendline should go DOWN.', 'savings', {
    motion: 'outcome', category: 'Cost', recurrence: 'quarterly', layout: COST_LAYOUT,
    tracks: 'Monthly cloud and infrastructure spend, trending toward your floor.',
    sources: ['postgres', 'google_sheets', 'url'],
    agents: [],
  }),
  template('engineering-org-open-bugs', 'engineering', 'org', 'Reduce open bug count', 'Drive the open-defect count down and keep it down.', 'custom_kpi', {
    motion: 'outcome', category: 'Quality', unit: 'count', direction: 'decrease', layout: COUNT_LAYOUT,
    tracks: 'Open defects across the tracker, counted on every sync.',
    sources: ['postgres', 'google_sheets', 'url'],
    agents: ['eng-quality-escape-review', 'eng-issue-triage-routing'],
  }),
  template('engineering-personal-bug-backlog', 'engineering', 'personal', 'Clear my bug backlog', 'Your personally-assigned open issues, trending to a target.', 'custom_kpi', {
    motion: 'outcome', category: 'Quality', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Open issues assigned to you.',
    sources: ['postgres', 'google_sheets', 'url'],
    agents: ['eng-issue-triage-routing'],
  }),
  template('engineering-personal-ship-cadence', 'engineering', 'personal', 'Ship N releases this quarter', 'A personal shipping-cadence target for the quarter.', 'custom_kpi', {
    motion: 'outcome', category: 'Delivery', unit: 'count', recurrence: 'quarterly', layout: PERSONAL_LAYOUT,
    tracks: 'Releases you shipped this quarter.',
    sources: ['postgres', 'google_sheets'],
    agents: ['eng-sprint-risk-forecaster'],
  }),
  template('engineering-org-release-go-no-go', 'engineering', 'org', 'A go/no-go brief before every release', 'Every release gets a named decision instead of a hopeful deploy.', 'custom_kpi', {
    motion: 'action', category: 'Delivery', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a release readiness brief with named blockers and owners',
    tracks: 'Releases that shipped with a completed go/no-go brief this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['eng-release-readiness-room', 'eng-pr-review-checklist-bot'],
  }),
  template('engineering-org-p1-incidents', 'engineering', 'org', 'Cut Sev-1 incidents', 'The count of the incidents that wake people up.', 'custom_kpi', {
    motion: 'outcome', category: 'Quality', unit: 'count', direction: 'decrease', recurrence: 'quarterly', layout: COUNT_LAYOUT,
    tracks: 'Severity-1 incidents declared this quarter.',
    sources: ['postgres', 'google_sheets', 'slack_assisted'],
    agents: ['eng-incident-context-assembler', 'eng-oncall-handoff'],
  }),
  template('engineering-org-incident-context-packet', 'engineering', 'org', 'A context packet on every incident', 'Responders open a timeline, not a blank channel.', 'custom_kpi', {
    motion: 'action', category: 'Quality', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a timestamped incident context packet',
    tracks: 'Incidents that got a context packet this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['eng-incident-context-assembler', 'eng-oncall-handoff'],
  }),
  template('engineering-personal-review-turnaround', 'engineering', 'personal', 'Review PRs faster', 'Hours between a review being requested of you and you giving it.', 'custom_kpi', {
    motion: 'outcome', category: 'Delivery', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Median hours you take to respond to a review request.',
    sources: ['postgres', 'google_sheets'],
    agents: ['eng-pr-review-checklist-bot'],
  }),
  template('engineering-personal-capture-every-decision', 'engineering', 'personal', 'Capture every architecture decision', 'Decisions made in review threads become findable records.', 'custom_kpi', {
    motion: 'action', category: 'Delivery', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'a drafted ADR with evidence and tradeoffs',
    tracks: 'Architecture decisions you captured as an ADR this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['eng-architecture-decision-miner'],
  }),
  // ── Finance ─────────────────────────────────────────────────────────────
  template('finance-org-vendor-savings', 'finance', 'org', 'Reduce vendor spend', 'A company savings target across renegotiated and retired vendors.', 'savings', {
    motion: 'outcome', category: 'Cost', layout: COST_LAYOUT,
    tracks: 'Total vendor spend across the ledger, trending down.',
    sources: ['postgres', 'google_sheets'],
    agents: ['finance-spend-exception-review', 'fin-spend-anomaly-reporter'],
  }),
  template('finance-org-collected-revenue', 'finance', 'org', 'Collected-revenue target', 'Cash actually collected, not just booked — tracked from your ledger.', 'revenue', {
    motion: 'outcome', category: 'Revenue', recurrence: 'quarterly', layout: ORG_ROLLUP_LAYOUT,
    tracks: 'Cash received this quarter, not invoiced amounts.',
    sources: ['stripe', 'postgres', 'google_sheets'],
    agents: ['finance-cash-collection-prioritizer', 'fin-weekly-cash-ar-digest'],
  }),
  template('finance-personal-cost-center', 'finance', 'personal', 'Cut my cost center spend', 'A personal savings target for the budget lines you own.', 'savings', {
    motion: 'outcome', category: 'Cost', layout: PERSONAL_LAYOUT,
    tracks: 'Spend on the budget lines you own.',
    sources: ['postgres', 'google_sheets'],
    agents: ['finance-spend-exception-review'],
  }),
  template('finance-personal-dso', 'finance', 'personal', 'Bring DSO down', 'Days sales outstanding, trending down toward a target.', 'custom_kpi', {
    motion: 'outcome', category: 'Cost', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Average days between invoice and payment across your accounts.',
    sources: ['postgres', 'stripe', 'google_sheets'],
    agents: ['finance-cash-collection-prioritizer', 'fin-weekly-cash-ar-digest'],
  }),
  template('finance-org-gross-margin', 'finance', 'org', 'Improve gross margin', 'Revenue less cost of revenue, as a percentage.', 'custom_kpi', {
    motion: 'outcome', category: 'Cost', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Gross profit as a percentage of revenue, from the ledger.',
    sources: ['postgres', 'google_sheets', 'stripe'],
    agents: ['finance-margin-leakage-finder', 'finance-deal-economics-review'],
  }),
  template('finance-org-work-every-overdue-invoice', 'finance', 'org', 'Work every overdue invoice', 'Collections get worked by value and relationship, not by spreadsheet order.', 'custom_kpi', {
    motion: 'action', category: 'Cost', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a ranked collection queue with drafted outreach',
    tracks: 'Overdue invoices with outreach sent this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['finance-cash-collection-prioritizer', 'fin-weekly-cash-ar-digest'],
  }),
  template('finance-org-review-every-spend-exception', 'finance', 'org', 'Review every spend exception', 'Unusual spend gets a named reviewer before it becomes a surprise.', 'custom_kpi', {
    motion: 'action', category: 'Cost', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'an exception queue tied to approvals and plan',
    tracks: 'Spend exceptions reviewed and closed this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['finance-spend-exception-review', 'fin-spend-anomaly-reporter'],
  }),
  template('finance-personal-close-cycle', 'finance', 'personal', 'Close the books faster', 'Business days from period end to a closed set of books.', 'custom_kpi', {
    motion: 'outcome', category: 'Delivery', unit: 'count', direction: 'decrease', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    tracks: 'Business days taken to close the most recent period.',
    sources: ['google_sheets', 'postgres'],
    agents: ['finance-close-command-center'],
  }),
  template('finance-personal-explain-every-variance', 'finance', 'personal', 'Explain every material variance', 'Variances arrive with a reason attached, not a question mark.', 'custom_kpi', {
    motion: 'action', category: 'Quality', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'a cited variance narrative for leadership',
    tracks: 'Material variances you explained with cited evidence this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['finance-revenue-variance-explainer', 'finance-forecast-assumption-register'],
  }),
  // ── CSM ─────────────────────────────────────────────────────────────────
  template('csm-org-nrr', 'csm', 'org', 'Net revenue retention', 'NRR as a percentage target — the health metric of the book.', 'custom_kpi', {
    motion: 'outcome', category: 'Retention', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Revenue from existing accounts versus the same cohort a year ago.',
    sources: ['stripe', 'hubspot', 'salesforce', 'postgres'],
    agents: ['csm-renewal-readiness-review', 'csm-churn-risk-early-warning'],
  }),
  template('csm-org-expansion-mrr', 'csm', 'org', 'Grow expansion MRR', 'Upsell and expansion recurring revenue, tracked monthly.', 'mrr', {
    motion: 'outcome', category: 'Revenue', layout: REVENUE_LAYOUT,
    tracks: 'Recurring revenue added by upsells on existing accounts this month.',
    sources: ['stripe', 'hubspot', 'salesforce', 'postgres'],
    agents: ['csm-adoption-gap-finder', 'csm-renewal-readiness-review'],
  }),
  template('csm-personal-renewals', 'csm', 'personal', 'Renewals closed this quarter', 'Your renewal revenue against the quarter’s book.', 'revenue', {
    motion: 'outcome', category: 'Retention', recurrence: 'quarterly', layout: PERSONAL_LAYOUT,
    tracks: 'Renewal revenue you closed this quarter.',
    sources: ['hubspot', 'salesforce', 'stripe', 'google_sheets'],
    agents: ['csm-renewal-readiness-review', 'csm-renewal-risk-email'],
  }),
  template('csm-personal-churn-saves', 'csm', 'personal', 'Reduce churned accounts', 'Accounts lost from your book, trending down.', 'custom_kpi', {
    motion: 'outcome', category: 'Retention', unit: 'count', direction: 'decrease', layout: PERSONAL_LAYOUT,
    tracks: 'Accounts lost from your book this period.',
    sources: ['hubspot', 'salesforce', 'postgres', 'google_sheets'],
    agents: ['csm-churn-risk-early-warning', 'csm-escalation-command-center'],
  }),
  template('csm-org-gross-retention', 'csm', 'org', 'Gross revenue retention', 'Retention before any expansion — the honest churn number.', 'custom_kpi', {
    motion: 'outcome', category: 'Retention', unit: 'percent', layout: RATE_LAYOUT,
    tracks: 'Retained revenue from the starting cohort, excluding upsell.',
    sources: ['stripe', 'hubspot', 'salesforce', 'postgres'],
    agents: ['csm-churn-risk-early-warning', 'csm-health-score-explainer'],
  }),
  template('csm-org-plan-every-new-account', 'csm', 'org', 'A plan for every new account', 'Onboarding starts from a plan with owners and dates, not an intro call.', 'custom_kpi', {
    motion: 'action', category: 'Retention', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'an onboarding plan with owners, dates, and risk flags',
    tracks: 'New accounts that started with a completed onboarding plan this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['csm-onboarding-task-orchestrator', 'csm-onboarding-risk-radar'],
  }),
  template('csm-org-close-every-adoption-gap', 'csm', 'org', 'Close every adoption gap', 'Unused capability becomes a named play, not a health-score number.', 'custom_kpi', {
    motion: 'action', category: 'Retention', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a named adoption gap and the play to close it',
    tracks: 'Adoption gaps worked to a close this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['csm-adoption-gap-finder', 'csm-health-score-explainer'],
  }),
  template('csm-personal-brief-every-qbr', 'csm', 'personal', 'A real brief before every QBR', 'You walk in with outcomes and an ask, not a slide of usage charts.', 'custom_kpi', {
    motion: 'action', category: 'Retention', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'a QBR brief with outcomes, risks, and an expansion ask',
    tracks: 'QBRs you ran from a prepared brief this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['csm-qbr-prep-brief', 'csm-executive-briefing'],
  }),
  template('csm-personal-work-every-risk-flag', 'csm', 'personal', 'Work every risk flag in my book', 'A risk signal becomes a save play the same week it appears.', 'custom_kpi', {
    motion: 'action', category: 'Retention', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'a churn-risk brief with the save play',
    tracks: 'Risk flags in your book you worked this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['csm-churn-risk-early-warning', 'csm-escalation-command-center'],
  }),
]

export function goalTemplateByKey(key: string): GoalTemplate | null {
  return GOAL_TEMPLATES.find((entry) => entry.key === key) ?? null
}

/** The catalogue the gallery renders. Retired templates still resolve by key —
 *  see GoalTemplate.retired — so bookmarked links never 404. */
export const VISIBLE_GOAL_TEMPLATES: GoalTemplate[] = GOAL_TEMPLATES.filter(
  (entry) => !entry.retired,
)
