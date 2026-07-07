import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

const templateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  category: z.string().default('Custom'),
  instructions: z.string().min(1),
  integrations: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  model: z.string().default('gpt-4o'),
  exampleOutput: z.string().optional(),
  allowSubagents: z.boolean().optional(),
})

function serializeTemplate(template: any) {
  const config = template.configuration && typeof template.configuration === 'object' ? template.configuration as any : {}
  return {
    id: template.id,
    name: template.name,
    description: template.description || '',
    category: template.type,
    instructions: config.instructions || template.description || '',
    integrations: config.integrations || [],
    tags: config.tags || [],
    model: config.model || 'gpt-4o',
    exampleOutput: config.exampleOutput || '',
    allowSubagents: config.allowSubagents === true,
    custom: true,
  }
}

const builtInTemplates = [
  {
    "id": "01-sales-digest",
    "name": "Sales Digest",
    "description": "Generates a personalized daily sales digest for each enrolled user.",
    "category": "Daily Intelligence",
    "instructions": "Generates a personalized daily sales digest for each enrolled user. At 6 AM on weekdays, the workflow retrieves the list of digest subscribers from the User Config Store, queries Den via MCP for each user's relevant account and opportunity activity, then passes the data to the LLM to compose a concise, actionable summary. The finished digest is delivered via Messaging (Slack, Teams, or Email) to each user.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "daily"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Good morning, James. 3 accounts need attention today.\n\n• ManpowerGroup — New Business $494.5K (100% engaged), closes Oct 15. Momentum strong; confirm legal review this week.\n• Twitch Interactive — Renewal $313K slipping (10% engaged). No exec touch in 12 days — schedule a check-in.\n• Slice — Renewal $117K overdue (0% engaged). Flag to manager.\n\nPipeline in view: $3.8M across 20 accounts. Delivered to #sales-james."
  },
  {
    "id": "02-meeting-brief",
    "name": "Meeting Brief",
    "description": "Prepares an AI-generated briefing document before each upcoming meeting.",
    "category": "Daily Intelligence",
    "instructions": "Prepares an AI-generated briefing document before each upcoming meeting. A parent cron workflow fires every 15 minutes and invokes this sub-workflow for meetings approaching on the calendar. The workflow fetches account context from Den via MCP — recent activity, engagement history, key contacts — and passes it to the LLM to produce a concise meeting brief. The brief is delivered to the meeting owner via Messaging (Slack, Teams, or Email) so they walk in fully prepared.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "daily"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Briefing — ManpowerGroup, today 2:00 PM\n\nWho: Olivia Jenkins (Economic Buyer), + 2 stakeholders.\nDeal: New Business $494.5K, closes Oct 15, 100% engaged.\nSince last meeting: security review completed; 2 support tickets resolved.\nRisks: data-privacy/compliance raised by Elizabeth Moore.\nSuggested agenda: 1) close security follow-ups 2) confirm procurement timeline 3) align on go-live."
  },
  {
    "id": "03-silence-contract-monitor",
    "name": "Silence & Contract Monitor",
    "description": "Monitors accounts for engagement gaps that may signal churn risk.",
    "category": "Account Monitoring",
    "instructions": "Monitors accounts for engagement gaps that may signal churn risk. Every morning at 6:30 AM, the workflow pulls accounts and checks for those that have \"gone silent\" — no meaningful engagement activity within a configured lookback window. For flagged accounts, it uses the LLM to assess the severity of the silence, considering deal stage, contract dates, and historical patterns. Accounts deemed concerning are surfaced via Alert (Slack, Teams, or Email) so the owning rep or CSM can re-engage.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "account"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "⚠️ 2 accounts went quiet.\n\n• Slice — Renewal $117K, closes Dec 29. 0% engagement, no activity in 21 days. Contract in renewal window → churn risk HIGH.\n• Falken Group — no exec touch since the security review. Recommend a call before Friday.\n\nNo action needed on 18 other monitored accounts."
  },
  {
    "id": "04-opportunity-discovery",
    "name": "Opportunity Discovery",
    "description": "Surfaces hidden revenue opportunities by identifying accounts with recent engagement activity but no corresponding open opportunities in the pipeline.",
    "category": "Pipeline & Forecasting",
    "instructions": "Surfaces hidden revenue opportunities by identifying accounts with recent engagement activity but no corresponding open opportunities in the pipeline. On a weekly cadence, the workflow cross-references Den activity data against the CRM pipeline, flags accounts showing buying signals without active deals, and uses the LLM to analyze the strength of those signals. Findings are posted via Messaging (Slack, Teams, or Email) and optionally emailed, giving reps a curated list of accounts worth pursuing.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "3 hidden opportunities surfaced this week:\n\n• ABBYY — high engagement (Andrew Wright, Gregory Roberts) but no open opp. Est. $200K+ whitespace.\n• Five9 — expanded usage signals, single-product today. Cross-sell candidate.\n• HFF — champion promoted; warm intro path opened.\n\nTop pick: ABBYY — assign for discovery this week."
  },
  {
    "id": "05-forecast-coach",
    "name": "Forecast Coach",
    "description": "Provides AI-powered coaching insights for sales leaders by analyzing their team's open pipeline each week.",
    "category": "Pipeline & Forecasting",
    "instructions": "Provides AI-powered coaching insights for sales leaders by analyzing their team's open pipeline each week. Every Monday, the workflow pulls each leader's team pipeline from Den, filters for active deals, and uses the LLM to assess deal health — looking at engagement recency, stakeholder coverage, stage velocity, and risk indicators. The result is a per-leader coaching report delivered via email, highlighting deals that need attention and suggesting specific coaching actions.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Email"
    ],
    "tags": [
      "recurring",
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Forecast coaching — Team West, this week\n\nCommit: $1.2M (7 deals). Best case: $1.9M.\nAt risk: 2 commit deals with <20% engagement — coach reps to secure exec sponsor.\nSandbagging signal: 3 best-case deals at 100% engagement past close date — push to commit.\nCoaching focus: Rep D's deals all lack a documented next step."
  },
  {
    "id": "06-executive-inbox",
    "name": "Executive Inbox",
    "description": "Automates executive email triage by reading unread email messages, identifying those from customers or prospects, enriching them with CRM context from Den, and using AI to classify and route each message.",
    "category": "Account Monitoring",
    "instructions": "Automates executive email triage by reading unread email messages, identifying those from customers or prospects, enriching them with CRM context from Den, and using AI to classify and route each message. The AI Agent analyzes the email content alongside account history to determine urgency, category (support escalation, deal progression, renewal, executive outreach, etc.), and the appropriate internal channel or person. Routed messages land in the right Messaging channel (Slack, Teams, or Email) or trigger follow-up workflows, ensuring nothing falls through the cracks.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "account"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Inbox triage — 14 unread, 3 need you.\n\n1. Olivia Jenkins (ManpowerGroup) — asking for revised SOW. Reply today; deal $494.5K.\n2. Procurement@abbyy — security questionnaire attached. Route to SE.\n3. Champion at HFF — intro to their VP Eng. High value; respond personally.\n\n11 others summarized and archived."
  },
  {
    "id": "07-churn-risk-scorecard",
    "name": "Churn Risk Scorecard",
    "description": "Generates a weekly churn risk scorecard for the customer success team.",
    "category": "Customer Success",
    "instructions": "Generates a weekly churn risk scorecard for the customer success team. The workflow pulls engagement trends, support ticket volumes, champion contact activity, and product usage signals from Den and the CRM. An AI agent scores each account on a 1-10 churn risk scale, identifies the top risk drivers, and suggests specific save plays. The scorecard is delivered to CS managers via Messaging with accounts ranked by risk severity.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "customer"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Weekly churn risk — CS team\n\nRED (2): Slice (0% engaged, renewal overdue), Acme (support escalations up 3x).\nAMBER (4): declining logins, exec sponsor departed, NPS drop.\nGREEN (31).\n\nBiggest mover: Slice ↓ from Amber to Red. Recommend save play + exec outreach."
  },
  {
    "id": "08-renewal-prep-brief",
    "name": "Renewal Prep Brief",
    "description": "Automatically generates renewal preparation briefs at 60, 30, and 15 days before each account's renewal date.",
    "category": "Customer Success",
    "instructions": "Automatically generates renewal preparation briefs at 60, 30, and 15 days before each account's renewal date. The workflow queries the CRM for upcoming renewals, enriches each account with Den engagement trends, support history, expansion signals, and key contact activity. An AI agent produces a structured brief covering account health, risk factors, expansion opportunities, and a recommended renewal strategy. Briefs are delivered to the assigned CSM and account executive via Messaging.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "customer"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Renewal prep — ManpowerGroup (T-30 days)\n\nContract: $494.5K, renews Feb 20. Engagement 9% (down from 100% at signing).\nUsage: 2 of 5 seats active; core feature adoption low.\nRisks: champion quiet 3 weeks; competitor mentioned in last call.\nPlay: schedule value review, surface ROI data, re-engage exec sponsor."
  },
  {
    "id": "09-onboarding-pulse",
    "name": "Onboarding Pulse",
    "description": "Monitors newly closed deals during their first 90 days to detect accounts going dark before they become a retention problem.",
    "category": "Customer Success",
    "instructions": "Monitors newly closed deals during their first 90 days to detect accounts going dark before they become a retention problem. The workflow identifies recently closed-won accounts, checks Den engagement data for post-sale activity (meetings booked, emails exchanged, contacts engaged), and flags accounts with below-threshold engagement. An AI agent assesses each flagged account and recommends specific re-engagement actions. Alerts are sent to the CSM and sales handoff team via Messaging.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "customer"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Onboarding pulse — Day 45\n\n• Five9 — GREEN. Kickoff done, 4/5 milestones hit, daily active.\n• NewCo — AMBER. No admin login in 10 days; onboarding stalled at integration step. CSM: reach out today.\n\n1 account on track, 1 needs a nudge before the 90-day mark."
  },
  {
    "id": "10-activity-gap-detector",
    "name": "Activity Gap Detector",
    "description": "Compares each rep's weekly activity patterns against team benchmarks and top performer profiles using Den activity data.",
    "category": "Coaching & Enablement",
    "instructions": "Compares each rep's weekly activity patterns against team benchmarks and top performer profiles using Den activity data. Identifies reps with low outbound activity, thin multi-threading on key deals, or single-threaded opportunities missing executive engagement. An AI agent generates personalized coaching nudges for sales managers, highlighting specific gaps and suggesting actionable improvement areas. Delivered weekly to frontline managers via Messaging.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "coaching"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Activity gaps — this week\n\nRep C: 40% fewer outbound touches than team median; 0 exec meetings booked.\nRep A (top performer) benchmark: 22 touches, 5 multi-thread accounts.\nGap: Rep C's open deals average 1.2 contacts vs team 3.4 — coach on multi-threading."
  },
  {
    "id": "11-deal-hygiene-audit",
    "name": "Deal Hygiene Audit",
    "description": "Performs a weekly pipeline hygiene audit by scanning all open opportunities in the CRM and cross-referencing with Den engagement data.",
    "category": "Coaching & Enablement",
    "instructions": "Performs a weekly pipeline hygiene audit by scanning all open opportunities in the CRM and cross-referencing with Den engagement data. Flags deals with stale close dates, no recent activity, missing next steps, single-threaded contacts, or no executive engagement. An AI agent prioritizes the issues and generates a per-rep action list with specific cleanup tasks. Delivered to reps and their managers via Messaging every Monday morning.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "coaching"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Pipeline hygiene — 42 open opps scanned.\n\n9 flagged:\n• 4 past close date, not updated → push or lose.\n• 3 missing next step.\n• 2 amount blank on commit-stage deals.\n\nCleanest reps: A, D. Send list to managers for Friday cleanup."
  },
  {
    "id": "12-win-loss-debrief",
    "name": "Win/Loss Debrief Generator",
    "description": "Automatically generates a structured win/loss debrief when any deal closes (won or lost).",
    "category": "Coaching & Enablement",
    "instructions": "Automatically generates a structured win/loss debrief when any deal closes (won or lost). Triggered by a CRM webhook on stage change, the workflow pulls the full engagement timeline from Den — every meeting, email, contact involved, and engagement cadence throughout the deal cycle. An AI agent analyzes the timeline to produce a structured debrief: what worked, where engagement dropped, key turning points, multi-threading effectiveness, and lessons learned. The debrief is delivered to the rep, their manager, and optionally a shared enablement channel.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "coaching"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Win/Loss debrief — ManpowerGroup (WON, $494.5K)\n\nWhy we won: strong exec sponsor (Olivia Jenkins), fast security clearance, clear ROI.\nDeciding factor: real-time analytics vs incumbent.\nWatch-outs: procurement added 3 weeks; document for next time.\nReplicable play: lead with the analytics demo."
  },
  {
    "id": "13-competitive-displacement-alert",
    "name": "Competitive Displacement Alert",
    "description": "Monitors customer accounts for early signs of competitive displacement.",
    "category": "Strategic Intelligence",
    "instructions": "Monitors customer accounts for early signs of competitive displacement. The workflow scans Den engagement data for accounts where internal engagement has suddenly dropped while simultaneously checking for competitor mentions in email subjects, meeting titles, or CRM notes. An AI agent evaluates the combined signals to assess displacement risk and recommends defensive actions. High-risk alerts are sent immediately to the account owner and their manager via Messaging.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "🚨 Competitive signal — Keyslogic account\n\nElizabeth Moore raised fault-tolerance concerns and mentioned evaluating an alternative.\nEngagement dropped 40% in 2 weeks. Renewal in 90 days.\nRecommend: exec escalation + tailored reliability proof points this week."
  },
  {
    "id": "14-territory-heat-map",
    "name": "Territory Heat Map",
    "description": "Generates a weekly territory heat map digest for each rep, showing which accounts in their territory are heating up (increased inbound, new contacts engaging, meeting frequency rising) versus cooling down (declining engagement, unresponsive contacts).",
    "category": "Strategic Intelligence",
    "instructions": "Generates a weekly territory heat map digest for each rep, showing which accounts in their territory are heating up (increased inbound, new contacts engaging, meeting frequency rising) versus cooling down (declining engagement, unresponsive contacts). The workflow pulls Den engagement data across all accounts in each rep's territory, calculates week-over-week momentum scores, and uses an AI agent to summarize trends and recommend where to focus time. Delivered every Monday to help reps prioritize their week.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Territory heat map — Rep James\n\n🔥 Hot: ManpowerGroup, ABBYY, HFF (high engagement + open pipeline).\n🌤 Warm: Five9, Dropbox Paper (engaged, no open opp).\n❄️ Cold: 6 accounts, no activity 30d+.\n\nFocus this week: convert the 2 warm whitespace accounts."
  },
  {
    "id": "15-qbr-auto-prep",
    "name": "QBR Auto-Prep",
    "description": "Automatically prepares quarterly business review materials for every account on an upcoming QBR agenda.",
    "category": "Strategic Intelligence",
    "instructions": "Automatically prepares quarterly business review materials for every account on an upcoming QBR agenda. The workflow scans the calendar for meetings tagged as QBRs (or matching configurable title patterns), then for each account on the agenda, pulls the full quarter's engagement data from Den: meeting frequency, email volume, contacts engaged, key relationship changes, and deal progression. An AI agent generates a structured QBR prep document with executive summary, engagement trends, wins/risks, and talking points. Delivered to the account team 48 hours before the QBR.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "CRM",
      "Calendar",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "QBR pack — ManpowerGroup (Q3)\n\nHealth: GREEN. ARR $494.5K, 100% → 9% engagement (flag).\nWins: security review passed, 2 new use cases live.\nRisks: seat adoption 2/5; renewal Feb.\nProposed asks: expand to 5 teams, exec alignment on analytics roadmap.\nSlides drafted and attached."
  },
  {
    "id": "16-executive-sponsor-tracker",
    "name": "Executive Sponsor Tracker",
    "description": "Monitors executive-level contact engagement across strategic deals to ensure champion and sponsor relationships stay active.",
    "category": "Strategic Intelligence",
    "instructions": "Monitors executive-level contact engagement across strategic deals to ensure champion and sponsor relationships stay active. The workflow identifies open opportunities above a configurable deal value threshold, checks Den for executive contact engagement (VP+ titles), and flags deals where executive sponsors have gone silent (no meetings or emails in the configured lookback window). An AI agent assesses the risk of each silent-sponsor situation and recommends re-engagement tactics. Alerts are sent to the deal owner and sales leadership via Messaging.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Exec sponsor tracker — strategic deals\n\n• ManpowerGroup — sponsor Olivia Jenkins, last touch 3 days ago. HEALTHY.\n• Twitch — sponsor Dorian Quinn, last touch 18 days ago. AT RISK — no meeting booked.\n• ABBYY — no exec sponsor identified. GAP — map one this week."
  },
  {
    "id": "17-marketing-sales-handoff-scorer",
    "name": "Marketing-to-Sales Handoff Scorer",
    "description": "Enriches marketing-qualified leads at the moment of handoff by checking Den for existing engagement history.",
    "category": "Pipeline & Forecasting",
    "instructions": "Enriches marketing-qualified leads at the moment of handoff by checking Den for existing engagement history. When a new MQL is created in the CRM or marketing automation platform, the workflow queries Den to see if the account already has relationship history — prior meetings, email threads, known contacts, or past opportunities. An AI agent scores the handoff quality (hot / warm / cold) and generates a context brief for the receiving SDR or AE, so they never walk into a \"cold\" call that's actually warm. Delivered instantly via Messaging.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "MQL handoff — 5 leads scored\n\n• A. Wright (ABBYY) — SCORE 92. Existing engaged account, buying-committee member. Route to AE now.\n• J. Doe (unknown co) — SCORE 34. No Den footprint, generic title. Nurture.\n\n2 hot, 1 warm, 2 nurture. Hot leads assigned round-robin."
  },
  {
    "id": "18-channel-pulse",
    "name": "Channel Pulse",
    "description": "Sends quick, 60-second scannable updates to internal customer channels with relevant account information from the last 7 days.",
    "category": "Account Monitoring",
    "instructions": "Sends quick, 60-second scannable updates to internal customer channels with relevant account information from the last 7 days. Designed to keep the extended team and executives abreast of what's happening in key accounts without requiring them to dig through CRM data or attend every meeting.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "account"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "#account-manpowergroup — 60-sec update\n\n💰 $494.5K New Business, closes Oct 15 · 100% engaged\n📈 Security review passed; SOW in legal\n⚠️ Watch: procurement timeline\n👤 Owner: Olivia Jenkins"
  },
  {
    "id": "19-customer-stack-blueprint",
    "name": "Customer Stack Blueprint",
    "description": "Turns a customer workflow request and tool-stack intake into a reusable implementation blueprint that recommends the closest validated asset, the right orchestration recipe, and the connector substitutions required for CRM, delivery, and meeting-source differences.",
    "category": "Platform Enablement",
    "instructions": "Turns a customer workflow request and tool-stack intake into a reusable implementation blueprint that recommends the closest validated asset, the right orchestration recipe, and the connector substitutions required for CRM, delivery, and meeting-source differences.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Implementation blueprint — “Daily digest to Slack”\n\nSource stack: Salesforce (CRM), Gong (meetings), Slack (delivery).\nCanonical steps: 1) pull accounts+opps 2) enrich w/ meeting signals 3) compose digest 4) route to Slack.\nAdapters needed: salesforce→canonical, gong→canonical, canonical→slack.\nReuses 3 existing library patterns; 1 new adapter required."
  },
  {
    "id": "20-crm-signal-normalizer",
    "name": "CRM Signal Normalizer",
    "description": "Normalizes Salesforce, Dynamics 365, HubSpot, or custom CRM records into a canonical account, contact, opportunity, and activity payload so downstream Den workflows can be reused without forking business logic by CRM.",
    "category": "Platform Enablement",
    "instructions": "Normalizes Salesforce, Dynamics 365, HubSpot, or custom CRM records into a canonical account, contact, opportunity, and activity payload so downstream Den workflows can be reused without forking business logic by CRM.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "CRM"
    ],
    "tags": [
      "recurring",
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Normalized 128 CRM records (Salesforce → canonical)\n\nMapped: Opportunity→deal, Account→account, Owner→owner.\n12 records flagged: missing close_date (7), unmapped stage value (5).\nCanonical output validated against schema v2. Ready for downstream steps."
  },
  {
    "id": "21-meeting-intelligence-normalizer",
    "name": "Meeting Intelligence Normalizer",
    "description": "Normalizes meetings, transcripts, attendees, and action items from Gong, Zoom, Teams, Otter, Fireflies, Fathom, and other note-taker systems into one reusable meeting-intelligence payload for prep, coaching, and QBR workflows.",
    "category": "Platform Enablement",
    "instructions": "Normalizes meetings, transcripts, attendees, and action items from Gong, Zoom, Teams, Otter, Fireflies, Fathom, and other note-taker systems into one reusable meeting-intelligence payload for prep, coaching, and QBR workflows.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Calendar"
    ],
    "tags": [
      "recurring",
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Normalized 9 meetings (Gong + Zoom → canonical)\n\nExtracted: 9 transcripts, 23 attendees resolved to CRM contacts, 14 action items.\n2 attendees unmatched (external). 3 action items linked to open opps.\nOutput ready for the digest and brief workflows."
  },
  {
    "id": "22-multi-channel-delivery-router",
    "name": "Multi-Channel Delivery Router",
    "description": "Receives a ready-to-send insight payload, resolves whether it should land in Slack, Teams, email, or a webhook, adapts the format for that surface, and applies fallback routing without cloning the business logic for each tool.",
    "category": "Platform Enablement",
    "instructions": "Receives a ready-to-send insight payload, resolves whether it should land in Slack, Teams, email, or a webhook, adapts the format for that surface, and applies fallback routing without cloning the business logic for each tool.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Routed insight payload → Slack #sales-james\n\nResolved channel from owner identity (James McDaniel → Slack DM fallback: #sales-james).\nFormat: Slack blocks. Email fallback not needed (Slack reachable).\nDelivered at 06:00 MT. Receipt confirmed."
  },
  {
    "id": "23-identity-resolution-hub",
    "name": "Identity Resolution Hub",
    "description": "Resolves people, account, owner, and channel identities across CRM, messaging, and meeting systems into a canonical identity layer so downstream workflows stop breaking on duplicate humans, alias drift, and ambiguous account ownership.",
    "category": "Platform Enablement",
    "instructions": "Resolves people, account, owner, and channel identities across CRM, messaging, and meeting systems into a canonical identity layer so downstream workflows stop breaking on duplicate humans, alias drift, and ambiguous account ownership.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Resolved 42 identities across CRM + messaging\n\n• Olivia Jenkins → SF Contact 003x, Slack @olivia, owner of 2 opps.\n• 3 duplicate accounts merged (ManpowerGroup variants).\n• 2 unresolved externals flagged for review.\nCanonical identity map updated."
  },
  {
    "id": "24-workflow-contract-validator",
    "name": "Workflow Contract Validator",
    "description": "Validates canonical payloads between workflow steps so schema drift, missing fields, enum changes, and connector-specific shape changes are caught before they break downstream automations.",
    "category": "Platform Enablement",
    "instructions": "Validates canonical payloads between workflow steps so schema drift, missing fields, enum changes, and connector-specific shape changes are caught before they break downstream automations.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Contract validation — digest pipeline\n\n✅ Step 1→2 payload matches schema v2.\n❌ Step 2→3: field `engagement_score` missing on 4 records.\n⚠️ Step 3→4: extra field `legacy_id` (non-breaking).\nBlocking issue: 1. Fix before rollout."
  },
  {
    "id": "25-implementation-gap-audit",
    "name": "Implementation Gap Audit",
    "description": "Audits a customer stack or internal workflow request against the current library to identify what is already validated, what only has recipe coverage, and what still needs productization work before rollout.",
    "category": "Platform Enablement",
    "instructions": "Audits a customer stack or internal workflow request against the current library to identify what is already validated, what only has recipe coverage, and what still needs productization work before rollout.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Gap audit — customer request vs library\n\nRequested: Dynamics 365 → Teams digest.\nCovered: canonical model, Teams delivery adapter. ✅\nGaps: Dynamics 365 source adapter (not in library), owner-resolution for Dynamics ids.\nEffort: ~1 new adapter + mapping. Recommend before commit."
  },
  {
    "id": "26-orchestrator-migration-planner",
    "name": "Orchestrator Migration Planner",
    "description": "Transforms a validated workflow pattern plus source-tool implementation details into a migration plan for n8n, Make, Power Automate, Zapier, Workato, or custom code without losing workflow order, state handling, payload contracts, or delivery behavior.",
    "category": "Platform Enablement",
    "instructions": "Transforms a validated workflow pattern plus source-tool implementation details into a migration plan for n8n, Make, Power Automate, Zapier, Workato, or custom code without losing workflow order, state handling, payload contracts, or delivery behavior.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Migration plan — Salesforce → canonical digest\n\nSteps: 1) deploy sf-source adapter 2) map fields (12) 3) wire canonical→slack 4) validate w/ golden payloads.\nRisks: custom stage values need mapping table.\nEstimated 3 build steps, 1 validation gate. Plan attached."
  },
  {
    "id": "27-adapter-regression-monitor",
    "name": "Adapter Regression Monitor",
    "description": "Replays golden payloads through CRM, meeting, identity, and delivery adapters to catch functional regressions before connector changes break reusable workflow patterns.",
    "category": "Platform Enablement",
    "instructions": "Replays golden payloads through CRM, meeting, identity, and delivery adapters to catch functional regressions before connector changes break reusable workflow patterns.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP"
    ],
    "tags": [
      "recurring",
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Adapter regression — nightly replay\n\nReplayed 40 golden payloads through CRM/meeting/identity/delivery adapters.\n✅ 38 passed. ❌ 2 failed: salesforce adapter dropped `next_step` after API v60 change.\nSeverity: HIGH. Owner paged. Details attached."
  },
  {
    "id": "28-rollout-readiness-scorecard",
    "name": "Rollout Readiness Scorecard",
    "description": "Scores whether a customer stack is actually ready for deployment by evaluating connector access, identity coverage, delivery routes, ownership, security prerequisites, and QA gates before a workflow goes live.",
    "category": "Platform Enablement",
    "instructions": "Scores whether a customer stack is actually ready for deployment by evaluating connector access, identity coverage, delivery routes, ownership, security prerequisites, and QA gates before a workflow goes live.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Rollout readiness — Acme stack\n\nScore: 78/100 (AMBER).\n✅ CRM adapter, identity resolution, delivery.\n⚠️ Meeting adapter untested on their Gong instance.\n❌ No fallback channel configured.\nVerdict: fix 2 items before go-live."
  },
  {
    "id": "29-digital-chief-of-staff",
    "name": "Digital Chief of Staff",
    "description": "Reference-grade Digital Chief of Staff workflow that combines account-channel updates, executive briefing synthesis, and calendar task generation using shared n8n sub-workflows plus bounded MCP enrichment.",
    "category": "Strategic Intelligence",
    "instructions": "Reference-grade Digital Chief of Staff workflow that combines account-channel updates, executive briefing synthesis, and calendar task generation using shared n8n sub-workflows plus bounded MCP enrichment.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Calendar",
      "Slack"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Chief of Staff — daily brief for James\n\nTop 3 moves today: 1) ManpowerGroup SOW to legal 2) re-engage Twitch exec 3) ABBYY discovery.\nCalendar: 3 meetings, brief attached for each.\nInbox: 3 items need you (triaged).\nPipeline: $3.8M in view; 2 at-risk deals flagged."
  },
  {
    "id": "30-market-research-brief",
    "name": "Market Research Brief",
    "description": "Builds a weekly market-intelligence digest for target accounts by combining normalized external company-signal packets with Den relationship and opportunity context.",
    "category": "Strategic Intelligence",
    "instructions": "Builds a weekly market-intelligence digest for target accounts by combining normalized external company-signal packets with Den relationship and opportunity context.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Market brief — target accounts, this week\n\n• ManpowerGroup: announced Q3 hiring surge → expansion signal.\n• ABBYY: new CISO hired → security messaging resonates.\n• Twitch: cost-cutting reported → lead with ROI.\nSources: public filings + normalized account activity. Full brief attached."
  },
  {
    "id": "31-deal-inspection",
    "name": "Deal Inspection (Slack /dealcheck)",
    "description": "Runs a slash-command deal inspection by resolving the requested account and opportunity, pulling Den deal context, and returning the top risk, supporting evidence, and next actions in Slack.",
    "category": "Pipeline & Forecasting",
    "instructions": "Runs a slash-command deal inspection by resolving the requested account and opportunity, pulling Den deal context, and returning the top risk, supporting evidence, and next actions in Slack.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "/dealcheck ManpowerGroup — New Business\n\n$494.5K · closes Oct 15 · 100% engaged · owner Olivia Jenkins\nStage: Negotiation. Next step: legal review (this week).\nRisk: LOW. Multi-threaded (3 contacts), exec sponsor active.\nMEDDPICC: Metrics ✅ EB ✅ Champion ✅ Paper 🟡 (in legal)."
  },
  {
    "id": "32-revenue-orchestration",
    "name": "Revenue Orchestration (Approval-Gated)",
    "description": "Takes an external revenue signal, builds a proposed CRM update plus owner message, and pauses for Slack approval before sending the approved action downstream.",
    "category": "Pipeline & Forecasting",
    "instructions": "Takes an external revenue signal, builds a proposed CRM update plus owner message, and pauses for Slack approval before sending the approved action downstream.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Proposed CRM update (awaiting approval)\n\nSignal: security review passed on ManpowerGroup.\nProposed: advance stage → Negotiation, set next step “legal review by Fri”, notify Olivia.\nOwner message drafted. \n▶ Approve to apply · ✎ Edit · ✕ Discard"
  },
  {
    "id": "33-prospecting-brief",
    "name": "Prospecting Brief",
    "description": "Builds an on-demand prospecting brief by combining account status, recent account activity, and situation context into tailored outreach angles and next steps.",
    "category": "Strategic Intelligence",
    "instructions": "Builds an on-demand prospecting brief by combining account status, recent account activity, and situation context into tailored outreach angles and next steps.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack"
    ],
    "tags": [
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Prospecting brief — ABBYY\n\nStatus: engaged (Andrew Wright, Gregory Roberts), no open opp.\nRecent activity: 2 site visits, 1 pricing-page view.\nAngle: real-time analytics + security (new CISO).\nOpening: reference their Q3 hiring surge. Suggested contacts + email draft attached."
  },
  {
    "id": "34-manager-coaching-brief",
    "name": "Manager Coaching Brief",
    "description": "Creates an on-demand manager coaching brief by combining opportunity status, scorecard signal, and situation context into coaching points for the rep and manager.",
    "category": "Coaching & Enablement",
    "instructions": "Creates an on-demand manager coaching brief by combining opportunity status, scorecard signal, and situation context into coaching points for the rep and manager.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack"
    ],
    "tags": [
      "coaching"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Coaching brief — Rep C (this week)\n\nPipeline: $620K, 6 opps. Scorecard: activity below median, 2 deals single-threaded.\nCoaching points: 1) multi-thread ManpowerGroup 2) set next steps on all opps 3) book 2 exec meetings.\nTalk track and deal list attached."
  },
  {
    "id": "35-grounded-follow-up",
    "name": "Content Generation — Grounded Follow-Up",
    "description": "Generates a grounded follow-up draft using recent opportunity activity, deal-risk context, and situation evidence so the outbound message stays tied to the actual deal state.",
    "category": "Coaching & Enablement",
    "instructions": "Generates a grounded follow-up draft using recent opportunity activity, deal-risk context, and situation evidence so the outbound message stays tied to the actual deal state.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack"
    ],
    "tags": [
      "coaching"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Follow-up draft — ManpowerGroup (grounded in last call)\n\nSubject: Next steps after your security review\n\nHi Olivia — great to close out the security items today. As discussed, I've attached the revised SOW reflecting the analytics scope. Next: legal review by Friday, targeting Oct 15 go-live. Anything you need from me before then?\n(Cites: call 7/3, ticket #482)"
  },
  {
    "id": "36-pipeline-forecast-digest",
    "name": "Pipeline & Forecast Digest",
    "description": "Builds a pipeline and forecast digest by pulling top records, expanding at-risk opportunities, enriching each one with context, and summarizing the highest-priority forecast issues in Slack.",
    "category": "Pipeline & Forecasting",
    "instructions": "Builds a pipeline and forecast digest by pulling top records, expanding at-risk opportunities, enriching each one with context, and summarizing the highest-priority forecast issues in Slack.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Pipeline & forecast digest\n\nTop records: 20 accounts, $3.8M pipeline, 39 open opps.\nCommit $1.2M · Best case $1.9M.\nAt-risk (expanded): Twitch renewal $313K (10% engaged), Slice $117K (overdue).\nBiggest gap: Slice renewal, 0% engagement, past close."
  },
  {
    "id": "37-deal-risk-next-actions",
    "name": "AI Agents — Deal Risk + Next Actions",
    "description": "Creates an on-demand deal-risk brief by merging opportunity status, recent activity, engaged-person context, and situation evidence into a concise risk and next-action recommendation.",
    "category": "Pipeline & Forecasting",
    "instructions": "Creates an on-demand deal-risk brief by merging opportunity status, recent activity, engaged-person context, and situation evidence into a concise risk and next-action recommendation.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Deal risk + next actions — Twitch Interactive\n\nRisk: HIGH. Renewal $313K, 10% engaged, no exec touch 18 days.\nDrivers: champion quiet, competitor mentioned, past close date.\nNext actions: 1) exec escalation to Dorian Quinn 2) send ROI recap 3) book renewal review this week."
  },
  {
    "id": "38-account-planning-strategy",
    "name": "Account Planning & Strategy",
    "description": "Generates an account-planning strategy brief by combining account status, recent account activity, stakeholder engagement, and situation context into account-level priorities and next steps.",
    "category": "Strategic Intelligence",
    "instructions": "Generates an account-planning strategy brief by combining account status, recent account activity, stakeholder engagement, and situation context into account-level priorities and next steps.\n\nCarry this out as an AI agent: use the Den MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Den MCP",
      "Slack"
    ],
    "tags": [
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Account plan — ManpowerGroup\n\nCurrent: $494.5K New Business + $494.5K renewal. Engagement 100%/9%.\nWhitespace: 3 teams not yet using analytics (~$200K).\nStakeholders: Olivia Jenkins (EB), Elizabeth Moore (blocker on compliance).\nStrategy: land go-live, prove ROI, expand in Q4. 3 plays attached."
  },
  {
    "id": "39-salesai-upsell-engine",
    "name": "SalesAI Upsell Engine",
    "description": "Identifies and prioritizes SalesAI upsell targets with readiness scores, competitive-risk flags, and a ranked Top-20 motion plan.",
    "category": "Pipeline & Forecasting",
    "instructions": "You are the SalesAI Upsell Engine — an orchestrator. Find and rank the best accounts to expand SalesAI into, then deliver a sales-ready motion plan.\n\nBefore running, ask the user for: (1) the target segment — default \"Data Foundation + EDB only\" accounts (low-hanging fruit); stretch is \"ClosePlan-only\" customers such as Seismic, CRWD, ZS, PANW — and (2) the Slack channel to post to.\n\nSteps:\n1. Pull the in-segment account list from the Den MCP (Sales AI). If Snowflake is connected, join product-usage/feature-adoption data via a read query.\n2. For each candidate account, delegate scoring to the \"Upsell Account Scorer\" agent using the run_agent tool (pass the account name). It returns a 0-100 readiness score with sub-scores and risk flags. Score up to your per-run sub-agent limit; if the segment is larger, score the most promising first and say how many remain.\n3. Collect the scorecards, rank them, and take the Top 20. For each: readiness score, the 1-2 decision-makers to engage, the best-fit use case, and the single next action.\n4. Compose a concise, scannable brief and post it to the chosen Slack channel, with a 4-week deployment roadmap for the top 3.\n\nBe honest about data gaps and state counts precisely (\"top 20 of 142 in-segment; scored 15\"). Do not fabricate scores — they come from the Account Scorer's tool results.\n\nNote: this agent uses multi-agent handoff — enable \"Run other agents\" in its config, and make sure an \"Upsell Account Scorer\" agent exists (create it from that template).",
    "integrations": [
      "Den MCP",
      "Snowflake",
      "Slack"
    ],
    "tags": [
      "recurring",
      "weekly"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "SalesAI Upsell Engine — Data Foundation + EDB segment (top 20 of 142)\n\nTop targets by readiness:\n1. ManpowerGroup — 91/100. Data ✅ Features 🟡 Use-case ✅ Health ✅. Engage Olivia Jenkins (EB); use case: real-time analytics. Next: book exec value review.\n2. ABBYY — 84/100. New CISO → security angle. Engage Andrew Wright. Next: discovery on AI use cases.\n3. Five9 — 78/100. Single-product, expanding usage. Cross-sell candidate. Next: usage-based ROI recap.\n\n⚠️ Risk flags: Twitch (competitive mention, -18d exec touch), Slice (renewal overdue, 0% engaged).\n\n4-week roadmap (top 3): W1 discovery · W2 tailored demo · W3 business case · W4 proposal.\nPosted to #salesai-upsell.",
    "allowSubagents": true
  },
  {
    "id": "40-upsell-account-scorer",
    "name": "Upsell Account Scorer",
    "description": "Scores a single account's SalesAI upsell readiness — data quality, feature maturity, AI use-case fit, and risk — with a clear rationale.",
    "category": "Pipeline & Forecasting",
    "instructions": "You score ONE account's readiness to expand into SalesAI. Ask for the account name or id if not provided.\n\nUsing the Den MCP (and Snowflake product-usage data if connected), assess and return:\n- Overall readiness score 0-100.\n- Four sub-scores (0-100) with one-line rationale each: data quality/coverage, feature maturity/adoption, AI use-case fit, account health.\n- Risk flags: churn signals, competitive threats, win/loss patterns.\n- The single recommended next action and the decision-maker to engage.\n\nDerive every score from retrieved data — never guess. If a factor can't be assessed, say so and lower confidence rather than inventing a number. Keep the output compact and structured so it can feed a ranking step.",
    "integrations": [
      "Den MCP",
      "Snowflake"
    ],
    "tags": [
      "on-demand"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": "Account scorecard — ManpowerGroup\n\nReadiness: 91/100 (high confidence)\n• Data quality: 95 — full account + opp coverage, recent activity.\n• Feature maturity: 72 — core adopted, analytics unused (whitespace).\n• AI use-case fit: 96 — real-time analytics need stated by Janet Anderson.\n• Account health: 90 — 100% engaged on New Business, ARR trending up.\n\nRisk: LOW. Compliance concern raised by Elizabeth Moore — address in security review.\nNext action: book an exec value review with Olivia Jenkins (EB) on the analytics use case."
  }
]

export const GET = withAuthenticatedApi(async (request, auth) => {
  const stored = await prisma.agentTemplate.findMany({
    where: { organizationId: auth.organizationId, isActive: true },
    orderBy: { updatedAt: 'desc' },
  })
  const templates = [...builtInTemplates, ...stored.map(serializeTemplate)]
  const limit = Number(request.nextUrl.searchParams.get('limit'))
  return { success: true, templates: limit > 0 ? templates.slice(0, limit) : templates }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = templateSchema.parse(await request.json())
  const template = await prisma.agentTemplate.create({
    data: {
      name: data.name,
      description: data.description,
      type: data.category,
      configuration: {
        instructions: data.instructions,
        integrations: data.integrations,
        tags: data.tags,
        model: data.model,
        ...(data.exampleOutput ? { exampleOutput: data.exampleOutput } : {}),
        ...(data.allowSubagents ? { allowSubagents: true } : {}),
      },
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
    },
  })
  return { success: true, template: serializeTemplate(template) }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(templateSchema.partial()).parse(await request.json())
  const existing = await prisma.agentTemplate.findFirst({
    where: { id: body.id, organizationId: auth.organizationId },
  })
  if (!existing) throw new ApiError('Template not found', 404, 'NOT_FOUND')
  const config = (existing.configuration && typeof existing.configuration === 'object' ? existing.configuration : {}) as any
  const template = await prisma.agentTemplate.update({
    where: { id: body.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.category !== undefined && { type: body.category }),
      configuration: {
        ...config,
        ...(body.instructions !== undefined && { instructions: body.instructions }),
        ...(body.integrations !== undefined && { integrations: body.integrations }),
        ...(body.tags !== undefined && { tags: body.tags }),
        ...(body.model !== undefined && { model: body.model }),
        ...(body.exampleOutput !== undefined && { exampleOutput: body.exampleOutput }),
        ...(body.allowSubagents !== undefined && { allowSubagents: body.allowSubagents }),
      },
    },
  })
  return { success: true, template: serializeTemplate(template) }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.agentTemplate.deleteMany({
    where: { id, organizationId: auth.organizationId },
  })
  if (!result.count) throw new ApiError('Template not found', 404, 'NOT_FOUND')
  return { success: true }
})
