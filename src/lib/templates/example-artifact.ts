type ArtifactTemplate = {
  name: string
  description: string
  departments?: string[]
  seedKey?: string
  icon?: string
}

/**
 * Stable marker at the head of the artifact contract. The agent system prompt
 * detects it to know a run should emit the rich HTML artifact (and to suppress
 * the Markdown-only formatting directive that would otherwise override it).
 * Sharing one constant keeps the contract text and that detection in lockstep.
 */
export const ARTIFACT_CONTRACT_MARKER = 'Final artifact contract'

/**
 * The executable counterpart to the rendered preview. Keeping this beside the
 * preview generator prevents catalogue instructions and example artifacts from
 * drifting into two different products.
 */
export function artifactOutputContract(template: ArtifactTemplate): string {
  const department = template.departments?.[0]?.toLowerCase() || 'sales'
  const data = content[department] ?? content.sales
  const metricLabels = data.metrics.map(([, , label]) => label).join(', ')
  return `${ARTIFACT_CONTRACT_MARKER} (match the Output Example)
The final response must be the finished artifact—not a description of the work, a setup checklist, or a terse status update. Use current values from connected sources in place of the sample values shown in the catalogue preview.

When the agent response is rendered in Sublime or another HTML-capable destination, return one complete semantic HTML fragment using this exact component structure and class names:
<main class="artifact theme-${department}">
  <header class="hero"><div class="hero-icon">[relevant emoji]</div><div><p class="eyebrow">${data.label}</p><h1>${template.name}</h1><p class="subtitle">[one-sentence outcome]</p></div><span class="status">● [decision status]</span></header>
  <section class="metric-grid">[exactly four <div class="metric"><span>[emoji]</span><strong>[value]</strong><small>[label]</small></div> cards]</section>
  <section class="panel summary"><h2>✨ Executive summary</h2><p>[substantive synthesis]</p></section>
  <section class="panel"><div class="section-heading"><div><p class="eyebrow">Evidence-backed analysis</p><h2>🔎 Priority findings</h2></div><span class="count">[n] findings</span></div><div class="table-wrap"><table><thead><tr><th>Priority</th><th>Finding</th><th>What the evidence says</th><th>Source</th></tr></thead><tbody>[one row per material finding]</tbody></table></div></section>
  <section class="panel"><div class="section-heading"><div><p class="eyebrow">Recommended execution</p><h2>✅ Action plan</h2></div><span class="count">Owner + date assigned</span></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Next action</th><th>Owner</th><th>Due</th></tr></thead><tbody>[prioritized action rows]</tbody></table></div></section>
  <section class="panel"><h2>🧾 Evidence trail</h2><div class="source-grid">[one <div class="source"><strong>[system]</strong><p>[records used]</p><small>↻ [freshness]</small></div> per source]</div></section>
  <footer>🎉 [completed actions and delivery state]</footer>
</main>

Artifact population rules
- Populate four decision-useful metrics. Prefer these labels where the source data supports them: ${metricLabels}. Replace an unsupported metric with a more relevant sourced metric; never invent a value.
- Include 3–6 distinct findings, each with priority, a specific evidence statement, and its source system plus record/date/link when available.
- Include 3–6 ordered actions. Assign an owner and due date only when supported or safely derivable; otherwise write “Owner needed” or “Date needed”.
- The executive summary must synthesize the decision, why it matters, the principal risk or gap, and the next move in 90–160 words.
- HTML-escape all tool-provided text. Do not emit scripts, event handlers, iframes, remote styles, forms, or untrusted raw HTML.
- Do not copy catalogue sample companies, people, amounts, dates, scores, findings, or claims unless the connected records independently contain them.
- Return the HTML directly without a Markdown code fence, preamble, or postscript. Do not expose internal tool traces.
- If the destination is Slack, convert the same sections and facts to Slack mrkdwn because Slack does not render arbitrary HTML. If the destination is Gmail, send the semantic HTML artifact as the email body. Preserve every section and the same level of detail in either format.`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

type DepartmentContent = {
  label: string
  emoji: string
  status: string
  metrics: Array<[string, string, string]>
  summary: string
  findings: Array<[string, string, string, string]>
  actions: Array<[string, string, string, string]>
  evidence: Array<[string, string, string]>
  footer: string
}

const content: Record<string, DepartmentContent> = {
  sales: {
    label: 'Revenue intelligence report', emoji: '🎯', status: 'Qualified · Action ready',
    metrics: [['💰', '$84K', 'Qualified ARR'], ['📈', '82 / 100', 'Fit score'], ['🗓️', 'Sep 30', 'Target close'], ['👥', '4 of 6', 'Buying roles mapped']],
    summary: 'Acme Corp is a strong enterprise-fit opportunity with a confirmed operational pain, an identified budget owner, and a Q3 decision window. Momentum is positive, but Legal and IT Security have not yet joined the evaluation. The next seller action should widen the buying committee before commercial terms are introduced.',
    findings: [['High', 'Business pain is verified', 'Finance and Operations spend 18 hours each week reconciling approvals manually.', 'Granola · Jul 10'], ['High', 'Economic buyer identified', 'Dana Kim, VP Operations, owns the transformation budget and confirmed a Q3 decision.', 'Salesforce · Jul 11'], ['Medium', 'Security is an unmapped dependency', 'No security contact, questionnaire, or review date is recorded.', 'Salesforce · Jul 12'], ['Medium', 'Expansion signal', 'The initial 40-seat request could expand to 120 seats after the pilot.', 'Granola · Jul 10']],
    actions: [['1', 'Book workflow review with Dana and the Finance lead', 'Sarah Chen', 'Jul 16'], ['2', 'Send security overview and request IT stakeholder', 'Alex Morgan', 'Jul 15'], ['3', 'Draft a mutual action plan through target close', 'Sarah Chen', 'Jul 18'], ['4', 'Confirm pilot success criteria and seat expansion trigger', 'Solutions', 'Jul 19']],
    evidence: [['Salesforce', 'Account, opportunity, contacts, stage history', 'Updated 2h ago'], ['Granola', 'Discovery call and buyer commitments', 'Jul 10'], ['Slack', 'Owner notification and internal handoff', 'Queued']],
    footer: 'Salesforce opportunity updated · Mutual action plan drafted · Owner notified in #sales',
  },
  engineering: {
    label: 'Engineering decision report', emoji: '🛠️', status: 'Conditional go · 1 blocker',
    metrics: [['✅', '48 / 48', 'Tests passing'], ['🚧', '1', 'Release blocker'], ['🔀', '12', 'Changes reviewed'], ['⚡', 'Low', 'Rollback risk']],
    summary: 'Release 2.14 is functionally ready and the Slack orchestration path is covered end to end. One migration-safety issue remains: the workspace index change does not include a verified rollback. Resolve that item and rerun the database smoke test before approving production rollout.',
    findings: [['Blocker', 'Migration rollback is missing', 'The forward index migration is safe, but the down path has not been exercised against a populated workspace.', 'GitHub PR #482'], ['Passed', 'Slack thread continuity', 'First messages and thread continuations preserve the same conversation context.', 'Tests · 8 cases'], ['Passed', 'Permission boundaries', 'Workspace and private-channel discovery stay scoped to the connected organization.', 'Linear ENG-233'], ['Watch', 'Rate-limit handling', 'Backoff is configured; add production telemetry for repeated Slack 429 responses.', 'Runbook v3']],
    actions: [['1', 'Add and test the rollback migration', 'Priya N.', 'Today'], ['2', 'Run populated-database smoke suite', 'CI', 'After merge'], ['3', 'Confirm on-call owner and rollback window', 'Marco R.', 'Before deploy'], ['4', 'Publish release notes and support handoff', 'Release bot', 'Deploy +15m']],
    evidence: [['GitHub', 'PR diff, checks, review threads', '12 files'], ['Linear', 'Acceptance criteria and linked defects', '6 issues'], ['Confluence', 'Runbook and rollback procedure', 'v3']],
    footer: 'Review posted to #eng-reviews · Linear blocker assigned · Release checklist updated',
  },
  marketing: {
    label: 'Campaign performance report', emoji: '🚀', status: 'On track · Optimize mix',
    metrics: [['🧲', '186', 'New MQLs'], ['📊', '31.2%', 'MQL → SQL'], ['💵', '$246K', 'Pipeline sourced'], ['📣', '4.8×', 'Best asset ROAS']],
    summary: 'The Self-Serve Launch exceeded its MQL target and improved downstream conversion by 4.1 points. Customer-proof creative is driving the strongest qualified demand. Paid social is contributing volume but underperforming on sales acceptance, so next week’s plan shifts budget toward proof-led retargeting and role-specific landing pages.',
    findings: [['Winner', 'Customer story email', '42% open rate, 8.7% click rate, and 34 sales-accepted leads.', 'HubSpot · Email 04'], ['Opportunity', 'Operations segment', 'Converted 1.6× better than the blended audience after landing-page view.', 'HubSpot · Segment'], ['Under target', 'Paid social lead quality', 'Only 18% of paid-social MQLs became SQLs versus the 28% target.', 'HubSpot · Campaign'], ['Creative signal', 'Before/after workflow visual', 'Highest assisted conversion rate across approved variants.', 'Figma · Variant C']],
    actions: [['1', 'Move 15% of paid-social budget to email retargeting', 'Maya', 'Jul 15'], ['2', 'Launch Operations-specific landing page test', 'Web team', 'Jul 17'], ['3', 'Reuse customer-proof hook in webinar promotion', 'Content', 'Jul 16'], ['4', 'Review SQL quality with Sales', 'Demand Gen', 'Jul 19']],
    evidence: [['HubSpot', 'Campaign, funnel, and attribution metrics', 'Through Jul 12'], ['Figma', 'Approved creative variants and messaging', '6 assets'], ['Slack', 'Sales quality feedback', '14 comments']],
    footer: 'Performance snapshot appended · Optimization tasks assigned · Digest ready for #marketing',
  },
  finance: {
    label: 'Finance operating report', emoji: '💹', status: 'Watch · Within threshold',
    metrics: [['💰', '$1.24M', 'Revenue MTD'], ['📉', '-4.8%', 'Variance to plan'], ['🏦', '$6.7M', 'Cash balance'], ['⏳', '43 days', 'DSO']],
    summary: 'Revenue remains within the approved 5% variance band, but collections risk increased week over week. Two accounts represent 61% of balances older than 60 days. The base forecast should remain unchanged while Finance escalates those accounts and resolves the Northstar invoice dispute.',
    findings: [['High', 'Concentrated overdue AR', '$192,400 is more than 60 days overdue; Acme and Northstar drive 61%.', 'Snowflake · AR aging'], ['Medium', 'Northstar invoice dispute', 'The customer contests a $48,000 services line that lacks an attached acceptance record.', 'Salesforce · Case'], ['Positive', 'Enterprise expansion offset', 'Two closed-won expansions added $96,000 against the monthly gap.', 'Salesforce · Opportunities'], ['Watch', 'DSO increased', 'DSO moved from 39 to 43 days over the last two reporting periods.', 'Snowflake · Cash']],
    actions: [['1', 'Escalate Acme and Northstar to executive owners', 'Controller', 'Jul 14'], ['2', 'Attach services acceptance evidence to invoice', 'Deal Desk', 'Jul 15'], ['3', 'Reforecast if variance exceeds -5%', 'FP&A', 'Daily'], ['4', 'Review collections movement at close standup', 'AR team', 'Jul 16']],
    evidence: [['Snowflake', 'Revenue, cash, and AR aging actuals', 'Refreshed 06:00'], ['Salesforce', 'Opportunity movement and account context', 'Updated 2h ago'], ['Google Sheets', 'Board-approved operating plan', 'FY26 v7']],
    footer: 'Variance workbook updated · Collection owners notified · Leadership digest prepared',
  },
  csm: {
    label: 'Customer success plan', emoji: '🤝', status: 'At risk · Recovery plan active',
    metrics: [['❤️', '72 / 100', 'Health score'], ['💼', '$180K', 'ARR'], ['🔄', 'Sep 30', 'Renewal'], ['🎫', '2', 'Open escalations']],
    summary: 'Acme’s adoption is expanding, but renewal confidence is constrained by two unresolved billing issues and the loss of an executive sponsor. The recommended recovery motion is to close billing ownership this week, establish a new sponsor, and anchor the renewal conversation around the analytics expansion outcome.',
    findings: [['Risk', 'Executive sponsor gap', 'The former sponsor changed roles and no replacement is attached to the renewal.', 'Salesforce · Contacts'], ['Risk', 'Recurring billing friction', 'Two P1 tickets remain open; both mention inconsistent usage charges.', 'Zendesk · 90 days'], ['Win', 'Adoption expanded', 'Three additional teams onboarded and weekly active usage rose 22%.', 'Snowflake · Usage'], ['Opportunity', 'Analytics add-on', 'Operations requested consolidated reporting in two recent calls.', 'Granola · Jul 8']],
    actions: [['1', 'Assign billing escalation owner and customer update', 'Nina C.', 'Today'], ['2', 'Map and engage a replacement executive sponsor', 'CSM', 'Jul 16'], ['3', 'Build analytics value recap with usage evidence', 'Solutions', 'Jul 18'], ['4', 'Confirm renewal plan and mutual milestones', 'CSM + AE', 'Jul 19']],
    evidence: [['Salesforce', 'Commercials, stakeholders, renewal state', 'Updated today'], ['Zendesk', 'Support volume, severity, and sentiment', '90-day window'], ['Granola', 'Goals, objections, and commitments', '3 calls'], ['Snowflake', 'Adoption and feature usage', 'Through Jul 11']],
    footer: 'Success plan drafted · Escalation owners assigned · QBR page ready for review',
  },
}

function rows(values: string[][]): string {
  return values.map((cells) => `<tr>${cells.map((cell, index) => `<${index === 0 ? 'th' : 'td'}>${escapeHtml(cell)}</${index === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')
}

/** A detailed, populated end-product preview tailored to the template and department. */
export function exampleArtifactHtml(template: ArtifactTemplate): string {
  const department = template.departments?.[0]?.toLowerCase() || 'sales'
  const data = content[department] ?? content.sales
  const icon = template.icon || data.emoji
  return `<main class="artifact theme-${escapeHtml(department)}">
    <header class="hero"><div class="hero-icon">${escapeHtml(icon)}</div><div><p class="eyebrow">${escapeHtml(data.label)}</p><h1>${escapeHtml(template.name)}</h1><p class="subtitle">${escapeHtml(template.description)}</p></div><span class="status">● ${escapeHtml(data.status)}</span></header>
    <section class="metric-grid">${data.metrics.map(([emoji, value, label]) => `<div class="metric"><span>${emoji}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(label)}</small></div>`).join('')}</section>
    <section class="panel summary"><h2>✨ Executive summary</h2><p>${escapeHtml(data.summary)}</p></section>
    <section class="panel"><div class="section-heading"><div><p class="eyebrow">Evidence-backed analysis</p><h2>🔎 Priority findings</h2></div><span class="count">${data.findings.length} findings</span></div><div class="table-wrap"><table><thead><tr><th>Priority</th><th>Finding</th><th>What the evidence says</th><th>Source</th></tr></thead><tbody>${rows(data.findings)}</tbody></table></div></section>
    <section class="panel"><div class="section-heading"><div><p class="eyebrow">Recommended execution</p><h2>✅ Action plan</h2></div><span class="count">Owner + date assigned</span></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Next action</th><th>Owner</th><th>Due</th></tr></thead><tbody>${rows(data.actions)}</tbody></table></div></section>
    <section class="panel"><h2>🧾 Evidence trail</h2><div class="source-grid">${data.evidence.map(([source, detail, freshness]) => `<div class="source"><strong>${escapeHtml(source)}</strong><p>${escapeHtml(detail)}</p><small>↻ ${escapeHtml(freshness)}</small></div>`).join('')}</div></section>
    <footer>🎉 ${escapeHtml(data.footer)}</footer>
  </main>`
}
