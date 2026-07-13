import type { Department } from './departments'
import type { SeedTemplate } from './catalogue'

type Recipe = {
  key: string
  name: string
  goal: string
  required: string[]
  recommended: string[]
  icon: string
}

const RECIPES: Record<Exclude<Department, 'general'>, Recipe[]> = {
  sales: [
    { key: 'sales-account-intent-brief', name: 'Account Intent Brief', goal: 'Combine CRM history, call notes, and product signals into a cited account-priority brief for the next seller action.', required: ['salesforce', 'granola'], recommended: ['slack', 'notion'], icon: '🧭' },
    { key: 'sales-multithreading-map', name: 'Buying Committee Mapper', goal: 'Reconstruct the buying committee, flag missing roles, and draft a multithreading plan from CRM and conversation evidence.', required: ['salesforce', 'granola'], recommended: ['gmail', 'slack'], icon: '🕸️' },
    { key: 'sales-deal-desk-packet', name: 'Deal Desk Packet Builder', goal: 'Assemble commercial terms, approval risks, open questions, and a decision-ready deal desk packet.', required: ['salesforce', 'google_drive'], recommended: ['notion', 'slack'], icon: '📦' },
    { key: 'sales-territory-white-space', name: 'Territory White-Space Finder', goal: 'Compare CRM coverage with warehouse account signals to rank unworked whitespace and explain the next-best plays.', required: ['salesforce', 'snowflake'], recommended: ['google_sheets', 'slack'], icon: '🗺️' },
    { key: 'sales-call-coaching-loop', name: 'Call Coaching Loop', goal: 'Score recent discovery calls against CRM outcomes, identify repeat coaching themes, and deliver rep-specific practice prompts.', required: ['granola', 'salesforce'], recommended: ['notion', 'slack'], icon: '🎧' },
    { key: 'sales-renewal-expansion-radar', name: 'Renewal Expansion Radar', goal: 'Blend account activity, support friction, and CRM renewal context to surface expansion-ready and at-risk accounts.', required: ['salesforce', 'zendesk'], recommended: ['snowflake', 'slack'], icon: '📡' },
    { key: 'sales-sequence-personalizer', name: 'Signal-Based Sequence Personalizer', goal: 'Use CRM context and recent meeting evidence to create a personalized, multi-step outreach sequence with grounded claims.', required: ['hubspot', 'granola'], recommended: ['gmail', 'slack'], icon: '✉️' },
    { key: 'sales-forecast-evidence-auditor', name: 'Forecast Evidence Auditor', goal: 'Challenge forecast categories using CRM changes, meeting commitments, and warehouse outcomes, then flag unsupported calls.', required: ['salesforce', 'granola'], recommended: ['snowflake', 'google_sheets'], icon: '🔎' },
    { key: 'sales-mutual-action-plan', name: 'Mutual Action Plan Generator', goal: 'Turn deal milestones and call commitments into an owner-and-date mutual action plan ready for internal and customer review.', required: ['salesforce', 'granola'], recommended: ['notion', 'gmail'], icon: '🗓️' },
    { key: 'sales-loss-pattern-review', name: 'Closed-Lost Pattern Review', goal: 'Correlate lost-deal fields, call objections, and cohort data to explain recurring loss patterns and corrective actions.', required: ['salesforce', 'snowflake'], recommended: ['granola', 'slack'], icon: '🧩' },
  ],
  engineering: [
    { key: 'eng-release-readiness-room', name: 'Release Readiness Room', goal: 'Combine pull requests, delivery tickets, and runbook context into a release go/no-go brief with named blockers.', required: ['github', 'linear'], recommended: ['confluence', 'slack'], icon: '🚦' },
    { key: 'eng-incident-context-assembler', name: 'Incident Context Assembler', goal: 'Collect related code changes, incident tickets, and operational notes into a timestamped incident context packet.', required: ['github', 'jira'], recommended: ['confluence', 'slack'], icon: '🚨' },
    { key: 'eng-tech-debt-portfolio', name: 'Technical Debt Portfolio', goal: 'Cluster code and issue evidence into a ranked debt portfolio with impact, owner, and recommended remediation sequence.', required: ['github', 'linear'], recommended: ['notion', 'slack'], icon: '🏗️' },
    { key: 'eng-spec-implementation-drift', name: 'Spec-to-Implementation Drift Checker', goal: 'Compare product specs and design artifacts with shipped code and identify material behavior or scope drift.', required: ['github', 'figma'], recommended: ['confluence', 'linear'], icon: '📐' },
    { key: 'eng-dependency-upgrade-planner', name: 'Dependency Upgrade Planner', goal: 'Inventory risky dependencies, connect them to active projects, and produce staged upgrade tickets with test guidance.', required: ['github', 'jira'], recommended: ['confluence', 'slack'], icon: '⬆️' },
    { key: 'eng-oncall-handoff', name: 'On-Call Handoff Builder', goal: 'Summarize unresolved incidents, recent risky changes, and open operational work into a concise on-call handoff.', required: ['github', 'jira'], recommended: ['slack', 'confluence'], icon: '🛟' },
    { key: 'eng-architecture-decision-miner', name: 'Architecture Decision Miner', goal: 'Find implicit architecture decisions across code reviews and tickets, then draft ADRs with evidence and tradeoffs.', required: ['github', 'linear'], recommended: ['confluence', 'notion'], icon: '🏛️' },
    { key: 'eng-quality-escape-review', name: 'Quality Escape Review', goal: 'Trace production defects back through tickets, pull requests, and review history to identify preventable quality escapes.', required: ['github', 'jira'], recommended: ['linear', 'slack'], icon: '🧪' },
    { key: 'eng-sprint-risk-forecaster', name: 'Sprint Risk Forecaster', goal: 'Blend issue progress, code activity, and dependency notes to predict sprint misses and recommend scope interventions.', required: ['linear', 'github'], recommended: ['confluence', 'slack'], icon: '⏱️' },
    { key: 'eng-api-change-coordinator', name: 'API Change Coordinator', goal: 'Detect contract-changing pull requests, find dependent work, and prepare coordinated rollout and communication tasks.', required: ['github', 'jira'], recommended: ['confluence', 'slack'], icon: '🔌' },
  ],
  marketing: [
    { key: 'marketing-campaign-command-center', name: 'Campaign Command Center', goal: 'Combine campaign CRM performance, creative assets, and project delivery status into one actionable campaign brief.', required: ['hubspot', 'figma'], recommended: ['asana', 'slack'], icon: '🎛️' },
    { key: 'marketing-content-repurpose-engine', name: 'Content Repurpose Engine', goal: 'Turn customer conversations and approved messaging into channel-specific content briefs with source-backed claims.', required: ['hubspot', 'granola'], recommended: ['notion', 'google_drive'], icon: '♻️' },
    { key: 'marketing-launch-readiness', name: 'Launch Readiness Coordinator', goal: 'Reconcile launch tasks, creative approvals, enablement docs, and stakeholder updates into a readiness scorecard.', required: ['asana', 'figma'], recommended: ['notion', 'slack'], icon: '🚀' },
    { key: 'marketing-voice-of-customer', name: 'Voice-of-Customer Synthesizer', goal: 'Combine CRM segments, support conversations, and call notes into cited messaging themes and objections.', required: ['hubspot', 'zendesk'], recommended: ['granola', 'notion'], icon: '🗣️' },
    { key: 'marketing-lead-quality-loop', name: 'Lead Quality Feedback Loop', goal: 'Compare marketing source data with downstream CRM outcomes to recommend targeting and qualification changes.', required: ['hubspot', 'salesforce'], recommended: ['google_sheets', 'slack'], icon: '🔁' },
    { key: 'marketing-creative-performance-review', name: 'Creative Performance Review', goal: 'Connect campaign results to creative variants and produce evidence-based iteration recommendations.', required: ['hubspot', 'figma'], recommended: ['google_sheets', 'slack'], icon: '🎨' },
    { key: 'marketing-event-followup-orchestrator', name: 'Event Follow-Up Orchestrator', goal: 'Segment event leads, enrich their context, and prepare personalized follow-up and sales handoff actions.', required: ['hubspot', 'google_sheets'], recommended: ['gmail', 'slack'], icon: '🎟️' },
    { key: 'marketing-editorial-operations', name: 'Editorial Operations Planner', goal: 'Turn campaign priorities and source material into a balanced editorial calendar with owners and dependencies.', required: ['monday', 'notion'], recommended: ['google_calendar', 'slack'], icon: '📰' },
    { key: 'marketing-competitive-narrative', name: 'Competitive Narrative Monitor', goal: 'Mine CRM losses, call notes, and content assets for competitor mentions and recommend messaging responses.', required: ['hubspot', 'granola'], recommended: ['google_drive', 'slack'], icon: '⚔️' },
    { key: 'marketing-funnel-anomaly-brief', name: 'Funnel Anomaly Brief', goal: 'Detect funnel conversion anomalies and connect them to campaign, segment, and sales follow-up evidence.', required: ['hubspot', 'snowflake'], recommended: ['google_sheets', 'slack'], icon: '📉' },
  ],
  finance: [
    { key: 'finance-revenue-variance-explainer', name: 'Revenue Variance Explainer', goal: 'Reconcile warehouse actuals with CRM pipeline changes and produce a cited variance narrative for leadership.', required: ['snowflake', 'salesforce'], recommended: ['google_sheets', 'slack'], icon: '📊' },
    { key: 'finance-close-command-center', name: 'Close Command Center', goal: 'Aggregate close tasks, reconciliation evidence, and unresolved owners into a daily close status and escalation brief.', required: ['snowflake', 'asana'], recommended: ['google_sheets', 'slack'], icon: '🧮' },
    { key: 'finance-cash-collection-prioritizer', name: 'Cash Collection Prioritizer', goal: 'Rank collection work using account value, CRM relationships, and warehouse payment behavior, with recommended outreach.', required: ['snowflake', 'salesforce'], recommended: ['gmail', 'google_sheets'], icon: '💵' },
    { key: 'finance-spend-exception-review', name: 'Spend Exception Reviewer', goal: 'Detect unusual spend patterns, connect them to approvals and plans, and produce an exception review queue.', required: ['snowflake', 'google_drive'], recommended: ['google_sheets', 'slack'], icon: '🧾' },
    { key: 'finance-board-metrics-packet', name: 'Board Metrics Packet Builder', goal: 'Assemble governed operating metrics, CRM context, and narrative commentary into a board-ready metrics packet.', required: ['snowflake', 'salesforce'], recommended: ['google_sheets', 'notion'], icon: '📚' },
    { key: 'finance-forecast-assumption-register', name: 'Forecast Assumption Register', goal: 'Extract and reconcile forecast assumptions across data, CRM, and planning notes with owners and confidence levels.', required: ['snowflake', 'salesforce'], recommended: ['notion', 'slack'], icon: '🧠' },
    { key: 'finance-margin-leakage-finder', name: 'Margin Leakage Finder', goal: 'Correlate deal terms and warehouse performance to identify margin leakage and quantify remediation opportunities.', required: ['snowflake', 'salesforce'], recommended: ['google_sheets', 'slack'], icon: '🕳️' },
    { key: 'finance-renewal-exposure-model', name: 'Renewal Exposure Model', goal: 'Combine contracted revenue, CRM renewal state, and support risk into a renewal exposure view.', required: ['snowflake', 'salesforce'], recommended: ['zendesk', 'google_sheets'], icon: '🛡️' },
    { key: 'finance-headcount-plan-monitor', name: 'Headcount Plan Monitor', goal: 'Compare plan assumptions, project demand, and actual cost data to surface headcount timing or capacity gaps.', required: ['snowflake', 'monday'], recommended: ['google_sheets', 'slack'], icon: '👥' },
    { key: 'finance-deal-economics-review', name: 'Deal Economics Reviewer', goal: 'Evaluate proposed deal economics against historical cohorts and approval policy before commercial sign-off.', required: ['salesforce', 'snowflake'], recommended: ['google_drive', 'slack'], icon: '⚖️' },
  ],
  csm: [
    { key: 'csm-health-score-explainer', name: 'Customer Health Score Explainer', goal: 'Explain account health using support, CRM, and usage evidence, then recommend the next customer action.', required: ['zendesk', 'salesforce'], recommended: ['snowflake', 'slack'], icon: '❤️' },
    { key: 'csm-escalation-command-center', name: 'Escalation Command Center', goal: 'Assemble open support issues, account commitments, and internal owners into an escalation plan and update cadence.', required: ['zendesk', 'salesforce'], recommended: ['jira', 'slack'], icon: '🚒' },
    { key: 'csm-renewal-readiness-review', name: 'Renewal Readiness Review', goal: 'Combine renewal details, product signals, and support history into a readiness score and gap-closing plan.', required: ['salesforce', 'zendesk'], recommended: ['snowflake', 'notion'], icon: '🔄' },
    { key: 'csm-success-plan-builder', name: 'Customer Success Plan Builder', goal: 'Turn account goals and recent conversations into measurable outcomes, milestones, owners, and review dates.', required: ['salesforce', 'granola'], recommended: ['notion', 'slack'], icon: '🏁' },
    { key: 'csm-adoption-gap-finder', name: 'Adoption Gap Finder', goal: 'Connect product usage cohorts with stakeholder goals and support friction to identify adoption interventions.', required: ['snowflake', 'salesforce'], recommended: ['zendesk', 'slack'], icon: '🪜' },
    { key: 'csm-executive-briefing', name: 'Executive Customer Briefing', goal: 'Create an executive-ready account briefing grounded in commercial, support, usage, and conversation evidence.', required: ['salesforce', 'granola'], recommended: ['zendesk', 'snowflake'], icon: '🎙️' },
    { key: 'csm-ticket-theme-to-roadmap', name: 'Ticket Theme → Roadmap Brief', goal: 'Cluster support themes, connect them to customer value, and prepare a prioritized product feedback brief.', required: ['zendesk', 'jira'], recommended: ['salesforce', 'slack'], icon: '🛣️' },
    { key: 'csm-onboarding-risk-radar', name: 'Onboarding Risk Radar', goal: 'Monitor onboarding milestones, account commitments, and support blockers to flag risks before go-live slips.', required: ['salesforce', 'asana'], recommended: ['zendesk', 'slack'], icon: '📡' },
    { key: 'csm-champion-change-playbook', name: 'Champion Change Playbook', goal: 'Detect stakeholder changes, reconstruct relationship context, and recommend a remapping and re-engagement plan.', required: ['salesforce', 'granola'], recommended: ['gmail', 'slack'], icon: '🤝' },
    { key: 'csm-portfolio-priority-planner', name: 'CSM Portfolio Priority Planner', goal: 'Rank the CSM book by renewal timing, support risk, product usage, and strategic value with daily actions.', required: ['salesforce', 'snowflake'], recommended: ['zendesk', 'google_sheets'], icon: '🗂️' },
  ],
}

function toSeed(department: Exclude<Department, 'general'>, recipe: Recipe): SeedTemplate {
  const integrations = Array.from(new Set([...recipe.required, ...recipe.recommended]))
  return {
    seedKey: recipe.key,
    name: recipe.name,
    description: recipe.goal,
    departments: [department],
    requiredIntegrations: recipe.required,
    recommendedIntegrations: recipe.recommended,
    integrations,
    kind: 'agent',
    // These reconstruction/analysis recipes are recurring operating reviews,
    // so both the Agent and Flow provisioning paths inherit a real weekly
    // schedule. The user can change or pause it after creation.
    trigger: {
      type: 'schedule',
      schedule: { type: 'cron', cron: '0 14 * * 1', time: '', timezone: 'UTC', isActive: true },
    },
    icon: recipe.icon,
    model: 'gpt-4o',
    instructions: [
      `You are the ${recipe.name} for the ${department} team.`,
      recipe.goal,
      `Use the connected ${integrations.join(', ')} systems as complementary evidence sources rather than isolated lookups.`,
      'Separate observed facts from interpretation, cite the source system for material claims, identify contradictions or missing data, and never invent records.',
      'Return a concise executive summary, a prioritized findings table, and concrete next actions with owners and dates when the source data supports them.',
    ].join(' '),
  }
}

export const MULTI_TOOL_SEEDS: SeedTemplate[] = Object.entries(RECIPES).flatMap(([department, recipes]) =>
  recipes.map((recipe) => toSeed(department as Exclude<Department, 'general'>, recipe)),
)
