import type { FlowGraph } from '@/lib/flows/graph'
import type { Department } from './departments'
import { MULTI_TOOL_SEEDS } from './catalogue-expansion'
import { withTemplateOutputStandard } from './output-standard'

export type TemplateAgentSpec = { ref: string; title: string; instructions: string; model?: string; integrations: string[] }
export type SeedTemplate = {
  seedKey: string; name: string; description: string
  departments: Department[]; requiredIntegrations: string[]; recommendedIntegrations: string[]
  kind: 'agent' | 'flow'
  instructions?: string; model?: string; integrations?: string[]
  agents?: TemplateAgentSpec[]; flowGraph?: FlowGraph
  trigger?: {
    type: 'manual' | 'schedule'
    schedule?: {
      type: 'cron'
      cron: string
      time: string
      timezone: string
      isActive: boolean
    }
  }
  icon?: string; exampleOutput?: string
}

// ── graph node builders (kept local; output is validated by flowGraphSchema in tests) ──
const trigger = (t: SeedTemplate['trigger'] = { type: 'manual' }) => ({ id: 'trigger', type: 'trigger' as const, data: { trigger: t } })
const agent = (id: string, ref: string, input: string, label: string) => ({ id, type: 'agent' as const, data: { agentId: ref, input, label } })
const slackStep = (id: string, channel: string, text: string, label = 'Post to Slack') =>
  ({ id, type: 'tool' as const, data: { label, connectionId: 'native:slack', toolName: 'post_message', args: JSON.stringify({ channel, text }) } })
const sfCreate = (id: string, sobject: string, fields: Record<string, string>, label = 'Create Salesforce record') =>
  ({ id, type: 'tool' as const, data: { label, connectionId: 'template:salesforce', toolName: 'salesforce_create_record', args: JSON.stringify({ sobject, fields }) } })
const gmailStep = (id: string, to: string, subject: string, bodyTok: string, label = 'Send email') =>
  ({ id, type: 'tool' as const, data: { label, connectionId: 'nango:gmail', toolName: 'gmail_send_email', args: JSON.stringify({ to, subject, body: bodyTok }) } })
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target })
const schedule = (cron: string) => ({
  type: 'schedule' as const,
  schedule: { type: 'cron' as const, cron, time: '', timezone: 'UTC', isActive: true },
})

const BASE_SEED_CATALOGUE: SeedTemplate[] = [
  // ───────────────────────── SALES ─────────────────────────
  {
    seedKey: 'sales-new-lead-to-sf-opportunity',
    name: 'New Lead → Enrich → Salesforce Opportunity',
    description: 'Webhook a new lead in, qualify it against Salesforce context, create the opportunity in Salesforce, and announce it in Slack.',
    departments: ['sales'], requiredIntegrations: ['salesforce'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '🎯',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'lead-qualifier', title: 'Lead Qualifier',
      instructions: 'You qualify inbound leads. Given a raw lead payload, use Salesforce account and contact context when available, decide fit (segment, ICP match, estimated ACV), and produce a concise Opportunity name, amount, and one-paragraph rationale. Reply as JSON with fields: opportunityName, amount, stage, rationale.',
      integrations: ['salesforce'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        agent('qualify', 'lead-qualifier', 'Qualify this raw lead: {{trigger.input}}', 'Qualify lead'),
        sfCreate('opp', 'Opportunity', { Name: '{{step.qualify.output.opportunityName}}', Amount: '{{step.qualify.output.amount}}', StageName: '{{step.qualify.output.stage}}' }),
        slackStep('notify', '#sales', 'New opportunity created: *{{step.qualify.output.opportunityName}}* ({{step.qualify.output.amount}}). {{step.qualify.output.rationale}}'),
      ],
      edges: [edge('trigger', 'qualify'), edge('qualify', 'opp'), edge('opp', 'notify')],
    },
  },
  {
    seedKey: 'sales-discovery-followup-writer',
    name: 'Discovery Call Follow-up Writer',
    description: 'Pulls the latest Granola discovery notes, drafts a crisp follow-up email with next steps, logs a Salesforce task, and DMs you the draft to send.',
    departments: ['sales'], requiredIntegrations: ['granola', 'salesforce'], recommendedIntegrations: ['gmail', 'slack'],
    kind: 'agent', icon: '✍️', model: 'gpt-4o',
    integrations: ['granola', 'salesforce', 'gmail', 'slack'],
    instructions: 'You are a sales follow-up writer. 1) Read the most recent Granola meeting note for the named account. 2) Draft a follow-up email: thank-you, 3 bullet recap, explicit next steps with dates, and a clear CTA. 3) Create a Salesforce Task capturing the next step and due date. 4) Send the draft to the rep over Slack for a final review before it goes out. Keep the email under 180 words and match the prospect\'s seniority.',
    exampleOutput: 'Subject: Great talking through your rollout timeline\n\nHi Dana — thanks for the time today...\n• Recap: ... • You raised: ... • Next: pilot scoping by Fri.\n(Logged SF Task "Send pilot scope — due 2026-07-15"; draft DM\'d to you.)',
  },
  {
    seedKey: 'sales-pipeline-hygiene-nudger',
    name: 'Pipeline Hygiene Nudger',
    description: 'Every weekday morning, finds stale or past-close-date opportunities in Salesforce and nudges each owner in Slack with exactly what to fix.',
    departments: ['sales'], requiredIntegrations: ['salesforce'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '🔔',
    trigger: schedule('0 13 * * 1-5'),
    agents: [{
      ref: 'hygiene-auditor', title: 'Pipeline Hygiene Auditor',
      instructions: 'Audit open Salesforce opportunities for hygiene problems: missing next step, past close date, no activity in 14+ days, or empty amount. Reply as JSON with fields: count (number of opportunities needing attention among the worst offenders, max 25) and details (a formatted multi-line markdown string, one bullet per opportunity: owner — oppName — issue — fixHint).',
      integrations: ['salesforce'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('0 13 * * 1-5')),
        agent('audit', 'hygiene-auditor', 'Audit this org\'s open pipeline for hygiene issues.', 'Audit pipeline'),
        slackStep('nudge', '#sales-ops', ':broom: Pipeline hygiene — {{step.audit.output.count}} opportunities need attention:\n{{step.audit.output.details}}'),
      ],
      edges: [edge('trigger', 'audit'), edge('audit', 'nudge')],
    },
  },
  {
    seedKey: 'sales-weekly-pipeline-digest',
    name: 'Weekly Pipeline Digest → Sheet + Slack',
    description: 'Monday 8am: summarizes HubSpot pipeline movement for the week, appends the snapshot to a Google Sheet, and posts the highlights to Slack.',
    departments: ['sales'], requiredIntegrations: ['hubspot', 'google_sheets'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '📈',
    trigger: schedule('0 12 * * 1'),
    agents: [{
      ref: 'pipeline-analyst', title: 'Pipeline Analyst',
      instructions: 'Summarize this week\'s HubSpot pipeline: new deals, stage advances, slips, and total weighted value vs last week. Append a one-row snapshot to the tracking Google Sheet, and produce a 5-bullet Slack-ready highlight summary. Reply with the highlight text.',
      integrations: ['hubspot', 'google_sheets'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('0 12 * * 1')),
        agent('analyze', 'pipeline-analyst', 'Produce this week\'s pipeline digest and append the snapshot to the tracking sheet.', 'Analyze pipeline'),
        slackStep('post', '#sales', ':bar_chart: *Weekly pipeline digest*\n{{step.analyze.output}}'),
      ],
      edges: [edge('trigger', 'analyze'), edge('analyze', 'post')],
    },
  },

  // ───────────────────────── ENGINEERING ─────────────────────────
  {
    seedKey: 'eng-pr-review-checklist-bot',
    name: 'PR Review Checklist Bot',
    description: 'On a PR-ready webhook, reviews the diff against a quality checklist (tests, types, migrations, docs) and posts a structured review summary to Slack.',
    departments: ['engineering'], requiredIntegrations: ['github'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '✅',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'pr-reviewer', title: 'PR Review Checklist Bot',
      instructions: 'Given a GitHub pull request reference, fetch the diff and files changed. Evaluate against: tests added/updated, type safety, DB migration safety, breaking changes, docs. Return a JSON object { verdict, blockers[], nits[], summary } where verdict ∈ approve|comment|request_changes.',
      integrations: ['github'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        agent('review', 'pr-reviewer', 'Review PR: {{trigger.input}}', 'Review PR'),
        slackStep('post', '#eng-reviews', ':white_check_mark: PR review ({{step.review.output.verdict}})\n{{step.review.output.summary}}'),
      ],
      edges: [edge('trigger', 'review'), edge('review', 'post')],
    },
  },
  {
    seedKey: 'eng-issue-triage-routing',
    name: 'Issue Triage & Routing Agent',
    description: 'Reads a new GitHub issue, classifies severity and area, files or links a Linear ticket to the right team, and pings the on-call channel when it is urgent.',
    departments: ['engineering'], requiredIntegrations: ['github', 'linear'], recommendedIntegrations: ['slack'],
    kind: 'agent', icon: '🧭', model: 'gpt-4o',
    integrations: ['github', 'linear', 'slack'],
    instructions: 'You triage incoming engineering issues. 1) Read the GitHub issue. 2) Classify: severity (P0–P3), area/team, and a one-line reproduction summary. 3) Create a Linear issue on the owning team with labels and the summary, or link an existing duplicate. 4) If P0/P1, post to #eng-oncall with the Linear link. Be conservative about severity and always cite the signal that set it.',
    exampleOutput: 'Triaged #4821 → P1, Billing. Linear BIL-233 created (labels: bug, p1). Posted to #eng-oncall: "P1 billing: refunds double-charging on retry."',
  },
  {
    seedKey: 'eng-release-notes-drafter',
    name: 'Release Notes Drafter',
    description: 'Collates merged GitHub PRs and closed Linear issues since the last release, drafts human-readable release notes, publishes them to Confluence, and shares the link in Slack.',
    departments: ['engineering'], requiredIntegrations: ['github', 'linear', 'confluence'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '📝',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'notes-collator', title: 'Release Notes Collator',
      instructions: 'Given a release range (tag or date), gather merged GitHub PRs and closed Linear issues. Group into Features / Fixes / Internal. Write concise, user-facing release notes in Markdown. Reply with the Markdown body.',
      integrations: ['github', 'linear'],
    }, {
      ref: 'notes-publisher', title: 'Confluence Publisher',
      instructions: 'Publish the provided release-notes Markdown as a new Confluence page under the Releases space, titled with today\'s date. Reply with the published page URL.',
      integrations: ['confluence'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        agent('collate', 'notes-collator', 'Draft release notes for range: {{trigger.input}}', 'Collate notes'),
        agent('publish', 'notes-publisher', 'Publish these release notes to Confluence:\n{{step.collate.output}}', 'Publish to Confluence'),
        slackStep('share', '#engineering', ':memo: Release notes published: {{step.publish.output}}'),
      ],
      edges: [edge('trigger', 'collate'), edge('collate', 'publish'), edge('publish', 'share')],
    },
  },
  {
    seedKey: 'eng-sprint-standup-digest',
    name: 'Sprint Standup Digest',
    description: 'Each weekday, summarizes Linear board movement (done, in-progress, blocked) into a tight standup digest and posts it to the team Slack channel.',
    departments: ['engineering'], requiredIntegrations: ['linear'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '☀️',
    trigger: schedule('30 13 * * 1-5'),
    agents: [{
      ref: 'standup-writer', title: 'Standup Digest Writer',
      instructions: 'Summarize the active Linear sprint since yesterday: what shipped, what is in progress, and what is blocked (with blocker + owner). Keep it to 8 bullets max, Slack mrkdwn. Reply with the digest text.',
      integrations: ['linear'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('30 13 * * 1-5')),
        agent('digest', 'standup-writer', 'Write today\'s standup digest from the active sprint.', 'Write standup'),
        slackStep('post', '#eng-standup', ':sunny: *Standup digest*\n{{step.digest.output}}'),
      ],
      edges: [edge('trigger', 'digest'), edge('digest', 'post')],
    },
  },

  // ───────────────────────── MARKETING ─────────────────────────
  {
    seedKey: 'mkt-inbound-mql-router',
    name: 'Inbound MQL Router',
    description: 'On a form-fill webhook, scores the lead against ICP, upserts it to HubSpot with the score, and routes hot MQLs to the right AE in Slack.',
    departments: ['marketing'], requiredIntegrations: ['hubspot'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '🧲',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'mql-scorer', title: 'MQL Scorer',
      instructions: 'Score an inbound marketing lead against ICP using the form payload and any enrichment. Return JSON { score (0-100), tier (hot|warm|cold), assignedTeam, reason }. Upsert the contact + score into HubSpot.',
      integrations: ['hubspot'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        agent('score', 'mql-scorer', 'Score and route this lead using HubSpot context: {{trigger.input}}', 'Score MQL'),
        slackStep('route', '#mkt-to-sales', ':magnet: New {{step.score.output.tier}} MQL (score {{step.score.output.score}}) → {{step.score.output.assignedTeam}}. {{step.score.output.reason}}'),
      ],
      edges: [edge('trigger', 'score'), edge('score', 'route')],
    },
  },
  {
    seedKey: 'mkt-campaign-brief-to-calendar',
    name: 'Campaign Brief → Content Calendar',
    description: 'Turns a one-line campaign goal into a structured brief and a two-week content calendar in Notion, with assets outlined in a linked Google Drive doc.',
    departments: ['marketing'], requiredIntegrations: ['hubspot', 'notion', 'google_drive'], recommendedIntegrations: [],
    kind: 'agent', icon: '🗓️', model: 'gpt-4o',
    integrations: ['hubspot', 'notion', 'google_drive'],
    instructions: 'You are a campaign planner. From a short campaign goal: 1) Check HubSpot Marketing for an existing matching campaign; create (or update) the campaign record in HubSpot with its goal, channels, and owner. 2) Write a crisp brief (audience, message, channels, KPIs). 3) Build a 2-week content calendar in Notion (date, channel, format, hook, owner), linking back to the HubSpot campaign. 4) Create a linked Google Drive doc outlining each asset. Keep hooks specific and channel-appropriate; do not invent metrics — mark KPIs as targets to confirm.',
    exampleOutput: 'HubSpot campaign "Self-Serve PLG Launch" created. Brief: "Launch self-serve tier to PLG signups"... Calendar (Notion): Mon LinkedIn teaser, Tue blog "3 ways...", Thu launch email... Assets doc: /Drive/Campaigns/self-serve.',
  },
  {
    seedKey: 'mkt-weekly-performance-digest',
    name: 'Weekly Marketing Performance Digest',
    description: 'Monday morning: rolls up HubSpot campaign and funnel metrics for the week, appends them to a Google Sheet, and posts a highlights digest to Slack.',
    departments: ['marketing'], requiredIntegrations: ['hubspot', 'google_sheets'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '📊',
    trigger: schedule('0 13 * * 1'),
    agents: [{
      ref: 'mkt-analyst', title: 'Marketing Performance Analyst',
      instructions: 'Summarize this week\'s HubSpot marketing performance: MQLs, conversion rate by source, top campaigns, and week-over-week deltas. Append a snapshot row to the metrics Google Sheet. Reply with a 6-bullet Slack highlight.',
      integrations: ['hubspot', 'google_sheets'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('0 13 * * 1')),
        agent('analyze', 'mkt-analyst', 'Produce this week\'s marketing performance digest and append the snapshot.', 'Analyze performance'),
        slackStep('post', '#marketing', ':chart_with_upwards_trend: *Weekly marketing digest*\n{{step.analyze.output}}'),
      ],
      edges: [edge('trigger', 'analyze'), edge('analyze', 'post')],
    },
  },
  {
    seedKey: 'mkt-content-repurposer',
    name: 'Content Repurposer',
    description: 'Takes a published piece from Notion or Drive and spins it into a LinkedIn post, an X thread, and a newsletter blurb, then emails you the pack.',
    departments: ['marketing'], requiredIntegrations: ['hubspot', 'notion', 'google_drive'], recommendedIntegrations: ['gmail'],
    kind: 'agent', icon: '♻️', model: 'gpt-4o',
    integrations: ['hubspot', 'notion', 'google_drive', 'gmail'],
    instructions: 'You repurpose long-form content. Read the source doc (Notion page or Drive doc). Produce: 1) a LinkedIn post (hook + 3 insights + CTA), 2) a 5-tweet X thread, 3) a 60-word newsletter blurb, and stage the blurb as a draft marketing email in HubSpot. Preserve the original\'s claims and voice; no new stats. Email the finished pack to the requester.',
    exampleOutput: 'LinkedIn: "We cut onboarding time 40%. Here\'s how →"... X thread (1/5)... Newsletter draft staged in HubSpot Marketing Email... (emailed to you).',
  },

  // ───────────────────────── FINANCE ─────────────────────────
  {
    seedKey: 'fin-revenue-snapshot-variance-alert',
    name: 'Revenue Snapshot & Variance Alert',
    description: 'Daily: compares closed-won revenue in Salesforce against plan in a Google Sheet and alerts Slack when variance breaches threshold.',
    departments: ['finance'], requiredIntegrations: ['salesforce', 'google_sheets'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '💰',
    trigger: schedule('0 14 * * 1-5'),
    agents: [{
      ref: 'variance-analyst', title: 'Revenue Variance Analyst',
      instructions: 'Read closed-won revenue MTD/QTD from Salesforce and the plan targets from the finance Google Sheet. Compute variance (absolute + %). Return JSON { periodRevenue, planTarget, variancePct, breach (boolean), commentary }. Breach when |variancePct| >= 10.',
      integrations: ['salesforce', 'google_sheets'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('0 14 * * 1-5')),
        agent('analyze', 'variance-analyst', 'Compute today\'s revenue-vs-plan variance.', 'Analyze variance'),
        {
          id: 'gate', type: 'filter' as const,
          data: { label: 'Only alert on breach', match: 'all' as const, clauses: [{ left: '{{step.analyze.output.breach}}', op: 'eq' as const, right: 'true' }] },
        },
        slackStep('alert', '#finance', ':rotating_light: Revenue variance {{step.analyze.output.variancePct}}% vs plan. {{step.analyze.output.commentary}}'),
      ],
      edges: [edge('trigger', 'analyze'), edge('analyze', 'gate'), edge('gate', 'alert')],
    },
  },
  {
    seedKey: 'fin-new-deal-billing-handoff',
    name: 'New Deal → Billing Handoff',
    description: 'On a closed-won signal, assembles the billing packet from Salesforce, records it to a Google Sheet, and notifies finance in Slack.',
    departments: ['finance'], requiredIntegrations: ['salesforce', 'google_sheets'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '🧾',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'billing-packet', title: 'Billing Packet Assembler',
      instructions: 'For a closed-won Salesforce opportunity, assemble the billing packet: account, contract value, term, billing contact, start date, and PO if present. Append the packet to the billing Google Sheet. Return JSON { account, amount, term, billingEmail, startDate }.',
      integrations: ['salesforce', 'google_sheets'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        agent('assemble', 'billing-packet', 'Assemble the billing packet for opportunity: {{trigger.input}}', 'Assemble packet'),
        slackStep('notify', '#finance', ':receipt: Billing handoff ready for *{{step.assemble.output.account}}* ({{step.assemble.output.amount}}), starting {{step.assemble.output.startDate}}. The packet was added to the billing sheet.'),
      ],
      edges: [edge('trigger', 'assemble'), edge('assemble', 'notify')],
    },
  },
  {
    seedKey: 'fin-spend-anomaly-reporter',
    name: 'Spend & Expense Anomaly Reporter',
    description: 'Weekly: queries spend/expense data from Snowflake for outliers and policy breaches, cross-checks the tracking Google Sheet, and emails finance a ranked anomaly report.',
    departments: ['finance'], requiredIntegrations: ['snowflake', 'google_sheets'], recommendedIntegrations: ['gmail'],
    kind: 'agent', icon: '🚩', model: 'gpt-4o',
    integrations: ['snowflake', 'google_sheets', 'gmail'],
    instructions: 'You are an expense auditor. Query the spend/expense data warehouse in Snowflake, cross-referencing the tracking Google Sheet for receipt and approval status. Flag anomalies: amounts >3x category median, duplicate charges, missing receipts, out-of-policy categories. Rank by risk. Email finance a report with a ranked table and a one-line recommendation per item. Never approve or reject — only surface.',
    exampleOutput: 'Top anomalies (Snowflake spend warehouse): 1) $4,200 "Software" (7x median, no receipt) 2) Duplicate $980 travel charge 3) ... (emailed to finance@).',
  },
  {
    seedKey: 'fin-weekly-cash-ar-digest',
    name: 'Weekly Cash & AR Digest',
    description: 'Monday: queries Snowflake for cash position and AR aging, snapshots it to a Google Sheet, and posts a leadership-ready digest to Slack.',
    departments: ['finance'], requiredIntegrations: ['snowflake', 'google_sheets'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '🏦',
    trigger: schedule('0 13 * * 1'),
    agents: [{
      ref: 'cash-analyst', title: 'Cash & AR Analyst',
      instructions: 'Query Snowflake for current cash position, AR aging buckets (0-30/31-60/61-90/90+), and DSO. Append a snapshot row to the finance Google Sheet. Return a 5-bullet Slack digest highlighting overdue accounts and DSO trend.',
      integrations: ['snowflake', 'google_sheets'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('0 13 * * 1')),
        agent('analyze', 'cash-analyst', 'Produce this week\'s cash & AR digest and append the snapshot.', 'Analyze cash & AR'),
        slackStep('post', '#finance-leadership', ':bank: *Weekly cash & AR digest*\n{{step.analyze.output}}'),
      ],
      edges: [edge('trigger', 'analyze'), edge('analyze', 'post')],
    },
  },

  // ───────────────────────── CSM ─────────────────────────
  {
    seedKey: 'csm-ticket-triage-escalation',
    name: 'Support Ticket Triage & Escalation',
    description: 'On a new Zendesk ticket, classifies urgency and sentiment, drafts a first response, and escalates angry or high-severity tickets to Slack.',
    departments: ['csm'], requiredIntegrations: ['zendesk'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '🎫',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'ticket-triager', title: 'Support Ticket Triager',
      instructions: 'Read a Zendesk ticket. Return JSON { priority (urgent|high|normal|low), sentiment (angry|frustrated|neutral|happy), category, draftReply, escalate (boolean) }. Set escalate=true for urgent priority OR angry sentiment. Keep draftReply empathetic and specific.',
      integrations: ['zendesk'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        agent('triage', 'ticket-triager', 'Triage Zendesk ticket: {{trigger.input}}', 'Triage ticket'),
        {
          id: 'gate', type: 'filter' as const,
          data: { label: 'Escalate only when flagged', match: 'all' as const, clauses: [{ left: '{{step.triage.output.escalate}}', op: 'eq' as const, right: 'true' }] },
        },
        slackStep('escalate', '#support-escalations', ':ticket: {{step.triage.output.priority}}/{{step.triage.output.sentiment}} ticket needs eyes: {{trigger.input}}'),
      ],
      edges: [edge('trigger', 'triage'), edge('triage', 'gate'), edge('gate', 'escalate')],
    },
  },
  {
    seedKey: 'csm-churn-risk-early-warning',
    name: 'Churn-Risk Early Warning',
    description: 'Daily: cross-references Zendesk ticket trends and Salesforce account health signals to flag at-risk accounts and alerts the CSM team in Slack.',
    departments: ['csm'], requiredIntegrations: ['zendesk', 'salesforce'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '⚠️',
    trigger: schedule('0 14 * * 1-5'),
    agents: [{
      ref: 'churn-scorer', title: 'Churn Risk Scorer',
      instructions: 'Combine Zendesk signals (ticket volume spike, negative sentiment, unresolved escalations) with Salesforce account health (usage drop, renewal date proximity, exec sponsor change). Return a JSON array of { account, riskScore (0-100), topSignals[], recommendedPlay } for accounts scoring >= 60, max 15.',
      integrations: ['zendesk', 'salesforce'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('0 14 * * 1-5')),
        agent('score', 'churn-scorer', 'Score accounts for churn risk today.', 'Score churn risk'),
        slackStep('alert', '#csm', ':warning: *Churn early-warning* — at-risk accounts:\n{{step.score.output}}'),
      ],
      edges: [edge('trigger', 'score'), edge('score', 'alert')],
    },
  },
  {
    seedKey: 'csm-qbr-prep-brief',
    name: 'QBR Prep Brief',
    description: 'Assembles a QBR brief for an account: support history from Zendesk, commercial context from Salesforce, recent Granola call notes, all written up in Notion.',
    departments: ['csm'], requiredIntegrations: ['zendesk', 'salesforce', 'granola'], recommendedIntegrations: ['notion'],
    kind: 'agent', icon: '📋', model: 'gpt-4o',
    integrations: ['zendesk', 'salesforce', 'granola', 'notion'],
    instructions: 'You prepare Quarterly Business Review briefs. For a named account: 1) Pull Salesforce commercials (ARR, renewal date, expansion pipeline). 2) Summarize Zendesk support trends (volume, CSAT, recurring issues). 3) Read recent Granola call notes for stated goals and objections. 4) Write a QBR brief in Notion: wins, risks, adoption, expansion opportunities, and 3 recommended talking points. Cite specifics; flag anything that needs the CSM to verify.',
    exampleOutput: 'QBR — Acme Corp: ARR $180k, renewal 2026-09. Wins: 3 new teams onboarded. Risks: 2 open P1s, CSAT dip. Expansion: analytics add-on. Talking points: ... (written to Notion).',
  },
  {
    seedKey: 'csm-onboarding-task-orchestrator',
    name: 'Onboarding Task Orchestrator',
    description: 'On a new closed-won signal, spins up the onboarding plan in Asana from the Salesforce deal, emails the customer a kickoff, and posts the plan to Slack.',
    departments: ['csm'], requiredIntegrations: ['salesforce', 'asana'], recommendedIntegrations: ['gmail', 'slack'],
    kind: 'flow', icon: '🚀',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'onboarding-planner', title: 'Onboarding Planner',
      instructions: 'For a newly closed Salesforce deal, read the account and product mix, then create an Asana onboarding project with milestone tasks (kickoff, provisioning, training, go-live) assigned by role with due dates. Return JSON { account, kickoffEmailBody, planSummary, customerEmail }.',
      integrations: ['salesforce', 'asana'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        agent('plan', 'onboarding-planner', 'Build the onboarding plan for deal: {{trigger.input}}', 'Build onboarding plan'),
        gmailStep('kickoff', '{{step.plan.output.customerEmail}}', 'Welcome aboard — your onboarding plan', '{{step.plan.output.kickoffEmailBody}}'),
        slackStep('post', '#customer-success', ':rocket: Onboarding kicked off for *{{step.plan.output.account}}*.\n{{step.plan.output.planSummary}}'),
      ],
      edges: [edge('trigger', 'plan'), edge('plan', 'kickoff'), edge('kickoff', 'post')],
    },
  },
]

const DEPARTMENT_CHANNEL: Record<string, string> = {
  sales: '#sales', engineering: '#engineering', marketing: '#marketing', finance: '#finance', csm: '#customer-success',
}

export type TemplateDelivery = { kind: 'slack' | 'gmail'; integration: 'slack' | 'gmail'; destination: string }

export function deliveryForSeed(seed: SeedTemplate): TemplateDelivery {
  const tools = [...seed.requiredIntegrations, ...seed.recommendedIntegrations, ...(seed.integrations ?? [])]
  const graphTools = (seed.flowGraph?.nodes ?? [])
    .filter((node) => node.type === 'tool')
    .map((node) => node.type === 'tool' ? node.data.connectionId.toLowerCase() : '')
  const gmailOnly = [...tools, ...graphTools].some((tool) => tool.includes('gmail'))
    && ![...tools, ...graphTools].some((tool) => tool.includes('slack'))
  return gmailOnly
    ? { kind: 'gmail', integration: 'gmail', destination: 'the requesting user by email' }
    : { kind: 'slack', integration: 'slack', destination: DEPARTMENT_CHANNEL[seed.departments[0] ?? ''] ?? '#team-updates' }
}

function normalizeDelivery(seed: SeedTemplate): SeedTemplate {
  const delivery = deliveryForSeed(seed)
  return {
    ...seed,
    requiredIntegrations: Array.from(new Set([...seed.requiredIntegrations, delivery.integration])),
    recommendedIntegrations: seed.recommendedIntegrations.filter((item) => item !== delivery.integration),
    integrations: seed.integrations
      ? Array.from(new Set([...seed.integrations, delivery.integration]))
      : seed.integrations,
  }
}

export const SEED_CATALOGUE: SeedTemplate[] = [...BASE_SEED_CATALOGUE, ...MULTI_TOOL_SEEDS].map(normalizeDelivery)

export function getSeedByKey(seedKey: string): SeedTemplate | undefined {
  return SEED_CATALOGUE.find((s) => s.seedKey === seedKey)
}

export function instructionsForSeed(seed: SeedTemplate): string {
  const delivery = deliveryForSeed(seed)
  const schedule = seed.trigger?.type === 'schedule' ? seed.trigger.schedule : undefined
  const friendlyCron: Record<string, string> = {
    '0 14 * * 1': 'Every Monday at 14:00',
    '0 13 * * 1': 'Every Monday at 13:00',
    '0 12 * * 1': 'Every Monday at 12:00',
    '0 14 * * 1-5': 'Every weekday at 14:00',
    '0 13 * * 1-5': 'Every weekday at 13:00',
    '30 13 * * 1-5': 'Every weekday at 13:30',
  }
  const cadence = schedule
    ? `Automatic schedule: ${friendlyCron[schedule.cron] ?? `cron ${schedule.cron}`} ${schedule.timezone}. The schedule is active immediately after the required tools are connected; the user may adjust it in Agent settings.`
    : 'Cadence: event-driven or on demand. Run once for each supplied business event; do not poll or repeat the same event. A recurring schedule can be added in Agent settings when the use case calls for batching.'
  const workflow = seed.agents?.length
    ? seed.agents.map((agent, index) => `${index + 1}. ${agent.title}: ${agent.instructions}`).join('\n')
    : `1. Gather the records needed to accomplish the stated objective from the connected systems.\n2. Reconcile the sources, identify missing or contradictory data, and complete the requested analysis or action.\n3. Produce and deliver the finished artifact.`
  const base = seed.instructions?.trim() || seed.description
  return withTemplateOutputStandard(`You are responsible for running the ${seed.name} workflow from start to finish.

Objective
${base}

Trigger and cadence
${cadence}

Execution workflow
${workflow}

Delivery requirement
Always deliver the final user-facing artifact through ${delivery.kind === 'slack' ? 'Slack' : 'Gmail'} to ${delivery.destination}. Do not stop after gathering data or merely say that the task is complete. Include the finished artifact in the delivery. If delivery fails, report the destination, error, and retryable next step; never claim it was sent.
${delivery.kind === 'gmail' ? 'Resolve the recipient from the trigger or requesting user profile. If no verified email address is available, ask for it; never guess an address.' : `Use ${delivery.destination} unless the user explicitly selects a different connected channel.`}

Guardrails
- Use only records returned by connected tools and preserve material source references.
- Separate observed facts from interpretations and recommendations.
- Never invent people, amounts, dates, statuses, links, or completed actions.
- Flag stale, missing, or contradictory evidence and state what must be verified.
- Do not overwrite, delete, publish, email, or post anything beyond the workflow's stated actions.
- Avoid duplicate delivery: one completed artifact per trigger unless the user explicitly requests another copy.
- Protect secrets and personal data; include only the minimum sensitive detail needed for the business outcome.`)
}

export type SerializedTemplate = ReturnType<typeof serializeSeed>
export function serializeSeed(seed: SeedTemplate) {
  const integrations = Array.from(new Set([...seed.requiredIntegrations, ...seed.recommendedIntegrations]))
  return {
    id: `seed:${seed.seedKey}`,
    name: seed.name,
    description: seed.description,
    category: seed.departments[0] ?? 'general',
    instructions: instructionsForSeed(seed),
    integrations,
    skills: [] as string[],
    tags: seed.departments as string[],
    model: seed.model ?? 'gpt-4o',
    exampleOutput: seed.exampleOutput ?? '',
    icon: seed.icon ?? '',
    allowSubagents: false,
    custom: false,
    authorName: 'Sublime',
    mine: false,
    autoGenerated: false,
    // additive catalogue fields (also echoed by serializeTemplate for DB rows):
    departments: seed.departments as string[],
    requiredIntegrations: seed.requiredIntegrations,
    recommendedIntegrations: seed.recommendedIntegrations,
    kind: seed.kind,
    trigger: seed.trigger ?? { type: 'manual' as const },
    seed: true as const,
    seedKey: seed.seedKey,
  }
}
