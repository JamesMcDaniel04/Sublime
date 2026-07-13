import type { SeedTemplate } from './catalogue'

type GmailRecipe = {
  seedKey: string
  name: string
  description: string
  department: 'sales' | 'engineering' | 'marketing' | 'finance' | 'csm'
  sources: string[]
  cron: string
  icon: string
  recipient: string
}

const GMAIL_RECIPES: GmailRecipe[] = [
  { seedKey: 'sales-executive-deal-review-email', name: 'Executive Deal Review Email', description: 'Email sales leadership a cited review of material deal movement, risks, missing stakeholders, and next actions.', department: 'sales', sources: ['salesforce', 'granola'], cron: '0 13 * * 1', icon: '📨', recipient: 'sales leadership and the opportunity owners' },
  { seedKey: 'sales-prospect-followup-digest', name: 'Prospect Follow-Up Digest', description: 'Turn recent customer conversations and CRM commitments into personalized follow-up drafts grouped by owner and urgency.', department: 'sales', sources: ['salesforce', 'granola'], cron: '30 13 * * 1-5', icon: '✉️', recipient: 'the responsible account executives' },
  { seedKey: 'eng-release-readiness-email', name: 'Release Readiness Email', description: 'Email release stakeholders a go/no-go assessment grounded in open work, recent code changes, and unresolved delivery risk.', department: 'engineering', sources: ['github', 'linear'], cron: '0 14 * * 1-5', icon: '🚦', recipient: 'engineering and release stakeholders' },
  { seedKey: 'eng-weekly-quality-review-email', name: 'Weekly Quality Review Email', description: 'Summarize production defects, risky changes, review gaps, and prioritized engineering follow-ups in a weekly quality memo.', department: 'engineering', sources: ['github', 'jira'], cron: '0 15 * * 5', icon: '🧪', recipient: 'engineering leads and quality owners' },
  { seedKey: 'marketing-campaign-performance-email', name: 'Campaign Performance Email', description: 'Email marketing leadership a decision-ready campaign performance review with creative evidence and recommended optimizations.', department: 'marketing', sources: ['hubspot', 'figma'], cron: '0 14 * * 1', icon: '📣', recipient: 'marketing leadership and campaign owners' },
  { seedKey: 'marketing-content-approval-email', name: 'Content Approval Email', description: 'Assemble pending campaign assets, messaging rationale, evidence, and explicit approval decisions into one stakeholder email.', department: 'marketing', sources: ['figma', 'asana'], cron: '0 16 * * 2,4', icon: '✅', recipient: 'campaign approvers and content owners' },
  { seedKey: 'finance-cash-risk-email', name: 'Cash Risk Email', description: 'Email finance owners a ranked cash-risk report with overdue concentration, disputes, collection owners, and dated actions.', department: 'finance', sources: ['snowflake', 'salesforce'], cron: '0 13 * * 1-5', icon: '💵', recipient: 'finance leadership and collection owners' },
  { seedKey: 'finance-monthly-variance-email', name: 'Monthly Variance Email', description: 'Reconcile actuals and commercial changes into a leadership-ready monthly variance narrative with evidence and open questions.', department: 'finance', sources: ['snowflake', 'salesforce'], cron: '0 15 2 * *', icon: '📊', recipient: 'finance and operating leadership' },
  { seedKey: 'csm-renewal-risk-email', name: 'Renewal Risk Email', description: 'Email customer teams a prioritized renewal-risk review using commercial context, support friction, and concrete recovery actions.', department: 'csm', sources: ['salesforce', 'zendesk'], cron: '0 14 * * 1', icon: '🔄', recipient: 'customer success leaders and account owners' },
  { seedKey: 'csm-customer-commitment-email', name: 'Customer Commitment Email', description: 'Convert recent customer meetings into a verified commitment register and polished follow-up email with owners and dates.', department: 'csm', sources: ['granola', 'salesforce'], cron: '0 16 * * 1-5', icon: '🤝', recipient: 'the customer team and internal account owner' },
]

export const GMAIL_SEEDS: SeedTemplate[] = GMAIL_RECIPES.map((recipe) => ({
  seedKey: recipe.seedKey,
  name: recipe.name,
  description: recipe.description,
  departments: [recipe.department],
  requiredIntegrations: [...recipe.sources, 'gmail'],
  recommendedIntegrations: [],
  integrations: [...recipe.sources, 'gmail'],
  kind: 'agent',
  model: 'gpt-4o',
  icon: recipe.icon,
  trigger: {
    type: 'schedule',
    schedule: { type: 'cron', cron: recipe.cron, time: '', timezone: 'UTC', isActive: true },
  },
  instructions: [
    `You own the ${recipe.name} workflow for the ${recipe.department} team.`,
    recipe.description,
    `Gather current evidence from ${recipe.sources.join(' and ')}, reconcile entity identities and timestamps, and distinguish observed facts from interpretation.`,
    'Produce a polished semantic HTML email with a descriptive subject, executive summary, metric callouts, prioritized findings with source references, risks and unknowns, and an action table with owner and date.',
    `Send exactly one completed artifact through the connected Gmail account to ${recipe.recipient}; resolve verified addresses from the trigger or user context and ask when an address is unavailable rather than guessing.`,
    'Do not send partial drafts, expose private data beyond the intended recipients, invent missing evidence, or claim delivery unless Gmail confirms it.',
  ].join(' '),
}))
