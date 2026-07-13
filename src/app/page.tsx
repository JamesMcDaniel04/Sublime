import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Bot, Cable, ScrollText, Sparkles, Zap, BrainCircuit } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import './landing.css'

// Rendered per-request: the try/catch around the Supabase auth check would
// otherwise swallow the dynamic-usage signal and bake a static page at build.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sublime — AI that knows your business',
  description:
    'Connect your business tools and deploy evidence-backed AI agents and workflows that learn how your team works.',
}

function Tick() {
  return (
    <span className="sl-l-tick" aria-hidden>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    </span>
  )
}

function Cross() {
  return (
    <span className="sl-l-cross" aria-hidden>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <path d="M12 5v8M12 17.5v.5" />
      </svg>
    </span>
  )
}

// Abstracted rows — gray bars suggesting earlier runs behind the spotlight.
function AbstractRow({ widths }: { widths: number[] }) {
  return (
    <div className="sl-l-abstract-row" aria-hidden>
      {widths.map((w, i) => (
        <span key={i} className="sl-l-bar" style={{ width: w }} />
      ))}
    </div>
  )
}

function ProductShot() {
  return (
    <div className="sl-l-stage sl-l-stage--3d sl-l-rise sl-l-rise--3" role="img" aria-label="Connected business tools feeding a live Sublime AI workflow.">
      <div className="sl-l-orbit sl-l-orbit--one" />
      <div className="sl-l-orbit sl-l-orbit--two" />
      <div className="sl-l-core">
        <div className="sl-l-core-face">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/sublime-mark-blue.svg" alt="" />
          <span>Business intelligence</span>
          <strong>Live and learning</strong>
        </div>
      </div>
      {[
        ['/logos/salesforce.svg', 'Salesforce', 'one'],
        ['/logos/slack.png', 'Slack', 'two'],
        ['/logos/googledrive.svg', 'Google Drive', 'three'],
        ['/logos/granola.jpg', 'Granola', 'four'],
      ].map(([src, label, position]) => (
        <div key={label} className={`sl-l-float-logo sl-l-float-logo--${position}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={label} />
        </div>
      ))}
      <div className="sl-l-appbar">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/sublime-mark-blue.svg" alt="" />
        Weekly pipeline digest
        <span className="sl-l-nav-spacer" />
        <span className="sl-l-pill sl-l-pill--info">Run #142</span>
        <span className="sl-l-pill sl-l-pill--good">Done</span>
      </div>

      <div className="sl-l-flag">
        <span>Every tool call, logged</span>
        <i />
      </div>

      <div className="sl-l-run-card">
        <div className="sl-l-run-head">
          <span className="sl-l-eyebrow">Run log</span>
          <span className="sl-l-run-meta">Today 09:00 · 41s</span>
        </div>
        <div className="sl-l-trace">
          <div className="sl-l-trace-row">
            <Tick />
            <b>hubspot.list_deals</b> 8 open deals
          </div>
          <div className="sl-l-trace-row">
            <Tick />
            <b>gmail.search_messages</b> 34 threads scanned
          </div>
          <div className="sl-l-trace-row sl-l-trace-row--risk">
            <Cross />
            <b>slack.post_message</b> #revenue-team not found
          </div>
          <div className="sl-l-trace-row">
            <Tick />
            <b>slack.post_message</b> delivered to #revenue
          </div>
        </div>
        <div className="sl-l-output">
          <span className="sl-l-eyebrow">Output</span>
          <p>
            Three deals need attention this week — $402,300 at risk. Falken Group went quiet after the security
            review; recommend a call before Friday.
          </p>
        </div>
      </div>

      <div className="sl-l-ghost">
        <AbstractRow widths={[130, 70, 90, 56]} />
        <AbstractRow widths={[100, 84, 60, 72]} />
      </div>
    </div>
  )
}

// Keep this showcase intentionally limited to providers that are present in
// the live integration catalogue and have a verified vector or bundled mark.
const integrationTools = [
  ['Salesforce', 'salesforce.com', '/logos/salesforce.svg'], ['Slack', 'slack.com', '/logos/slack.png'],
  ['Google Drive', 'drive.google.com', '/logos/googledrive.svg'], ['Google Sheets', 'sheets.google.com', '/logos/googlesheets.webp'],
  ['Monday', 'monday.com', '/logos/monday.jpg'], ['Figma', 'figma.com', '/logos/figma.svg'],
  ['GitHub', 'github.com'], ['Linear', 'linear.app'], ['Jira', 'atlassian.com'], ['Asana', 'asana.com'],
  ['Notion', 'notion.so'], ['Zendesk', 'zendesk.com'], ['HubSpot', 'hubspot.com'], ['Gmail', 'gmail.com'],
  ['Snowflake', 'snowflake.com'], ['Airtable', 'airtable.com'], ['Confluence', 'atlassian.com'], ['ClickUp', 'clickup.com'],
  ['Google Calendar', 'calendar.google.com'], ['Google Docs', 'docs.google.com'], ['Google Forms', 'forms.google.com'],
  ['Google Cloud', 'cloud.google.com'], ['Supabase', 'supabase.com'], ['Intercom', 'intercom.com'],
  ['PostHog', 'posthog.com'], ['Postman', 'postman.com'], ['YouTube', 'youtube.com'], ['GitLab', 'gitlab.com'],
  ['Microsoft Teams', 'teams.microsoft.com'], ['Hugging Face', 'huggingface.co'], ['Amplitude', 'amplitude.com'],
] as const

type LandingTool = readonly [name: string, domain: string, localSrc?: string]

const toolIconSlugs: Record<string, string> = {
  Slack: 'slack', 'Google Sheets': 'googlesheets', Monday: 'mondaydotcom', GitHub: 'github', Linear: 'linear',
  Jira: 'jira', Asana: 'asana', Notion: 'notion', Zendesk: 'zendesk', HubSpot: 'hubspot', Gmail: 'gmail',
  Snowflake: 'snowflake', Airtable: 'airtable', Confluence: 'confluence', Trello: 'trello', ClickUp: 'clickup',
  LaunchDarkly: 'launchdarkly', 'Google Calendar': 'googlecalendar', 'Google Docs': 'googledocs',
  'Google Forms': 'googleforms', 'Google Cloud': 'googlecloud', Supabase: 'supabase', Intercom: 'intercom',
  Figma: 'figma', PostHog: 'posthog', Postman: 'postman', YouTube: 'youtube', GitLab: 'gitlab',
  'Microsoft Teams': 'microsoftteams', 'Hugging Face': 'huggingface', Amplitude: 'amplitude',
}

function landingToolLogo([name, domain, localSrc]: LandingTool): string {
  // Keep bundled SVGs / trademark-only marks, otherwise use brand vector art.
  if (localSrc) return localSrc
  const vectorSlug = toolIconSlugs[name]
  return vectorSlug ? `https://cdn.simpleicons.org/${vectorSlug}` : `https://www.google.com/s2/favicons?domain=${domain}&sz=256`
}

function ToolCarouselRow({ tools, reverse = false }: { tools: readonly LandingTool[]; reverse?: boolean }) {
  const repeated = [...tools, ...tools]
  return (
    <div className="sl-l-tool-track-clip">
      <div className={`sl-l-tool-track${reverse ? ' sl-l-tool-track--reverse' : ''}`}>
        {repeated.map((tool, index) => {
          const [name] = tool
          return (
          <div className="sl-l-tool-chip" key={`${name}-${index}`} aria-hidden={index >= tools.length}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={landingToolLogo(tool)} alt={index < tools.length ? name : ''} />
            <span>{name}</span>
          </div>
          )
        })}
      </div>
    </div>
  )
}

export default async function Home() {
  // Signed-in visitors go straight to the app; everyone else sees the landing.
  // If Supabase isn't configured, the public page still renders.
  let user = null
  try {
    const supabase = await createClient()
    user = (await supabase.auth.getUser()).data.user
  } catch {
    user = null
  }
  if (user) redirect('/dashboard')

  return (
    <div className="sl-l-page">
      <header className="sl-l-wrap sl-l-nav">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/sublime-lockup-black.svg" alt="Sublime" style={{ height: 22 }} />
        <span className="sl-l-nav-spacer" />
        <a className="sl-l-nav-link" href="#features">
          What you get
        </a>
        <a className="sl-l-nav-link" href="#how">
          How it works
        </a>
        <Link href="/auth/login" className="sl-l-btn sl-l-btn--ghost sl-l-btn--sm">
          Sign in
        </Link>
        <Link href="/auth/signup" className="sl-l-btn sl-l-btn--dark sl-l-btn--sm">
          Get started
        </Link>
      </header>

      <section className="sl-l-wrap sl-l-hero">
        <div>
          <div className="sl-l-eyebrow sl-l-rise">— AI that learns how your business works</div>
          <h1 className="sl-l-h1 sl-l-rise">
            AI that knows <em>your business.</em>
          </h1>
          <p className="sl-l-lede sl-l-rise sl-l-rise--2">
            Connect the tools your team already uses. Sublime reconstructs how work gets done, then powers
            agents and workflows that deliver useful outcomes from day one.
          </p>
          <div className="sl-l-cta-row sl-l-rise sl-l-rise--2">
            <Link href="/auth/signup" className="sl-l-btn sl-l-btn--dark">
              Start building →
            </Link>
            <Link href="/auth/login" className="sl-l-btn sl-l-btn--ghost">
              Sign in
            </Link>
          </div>
          <div className="sl-l-tagline sl-l-rise sl-l-rise--3">
            <span>see what&apos;s coming</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/sublime-mark-blue.svg" alt="" />
            <span>know what to do</span>
          </div>
        </div>
        <ProductShot />
      </section>

      <section className="sl-l-logo-cloud" aria-labelledby="tools-heading">
        <div className="sl-l-tool-carousel" aria-label={`${integrationTools.length} available integration tools`}>
          <ToolCarouselRow tools={integrationTools.slice(0, 16)} />
          <ToolCarouselRow tools={integrationTools.slice(16)} reverse />
        </div>
        <div className="sl-l-wrap sl-l-logo-cloud-heading">
          <h2 id="tools-heading">All your tools in <em>one place.</em></h2>
          <p>One connected knowledge layer across the systems your team already trusts.</p>
        </div>
      </section>

      <section id="features" className="sl-l-section">
        <div className="sl-l-wrap">
          <div className="sl-l-eyebrow">— what you get</div>
          <h2 className="sl-l-section-h sl-l-big-statement">Builds immediately.<br /><em>Delivers from day one.</em></h2>
          <p className="sl-l-section-sub">
            No migration project or technical setup. Connect your business tools and Sublime handles the rest.
          </p>
          <div className="sl-l-feature-grid">
            <div className="sl-l-feature">
              <span className="sl-l-feature-icon">
                <Bot size={18} strokeWidth={2} />
              </span>
              <h3>Build agents in minutes</h3>
              <p>
                Describe the outcome in plain language. Sublime creates the agent, its instructions, delivery format,
                integrations, and schedule.
              </p>
            </div>
            <div className="sl-l-feature">
              <span className="sl-l-feature-icon">
                <Cable size={18} strokeWidth={2} />
              </span>
              <h3>Connect the tools you already use</h3>
              <p>
                Historical backfill and live events build a practical understanding of customers, projects,
                decisions, bottlenecks, and ownership.
              </p>
            </div>
            <div className="sl-l-feature">
              <span className="sl-l-feature-icon">
                <ScrollText size={18} strokeWidth={2} />
              </span>
              <h3>Read every run</h3>
              <p>
                Every run shows its evidence, tool calls, decisions, errors, and finished artifact—so teams can trust
                the work and improve it.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="how" className="sl-l-section sl-l-section--blue">
        <div className="sl-l-wrap">
          <div className="sl-l-eyebrow">— how it works</div>
          <h2 className="sl-l-section-h">Automate your work in <em>minutes.</em></h2>
          <div className="sl-l-steps">
            <div className="sl-l-step">
              <span className="sl-l-step-num">01</span>
              <h3>Connect your tools</h3>
              <p>Authorize the systems your team already uses. No migration required.</p>
            </div>
            <div className="sl-l-step">
              <span className="sl-l-step-num">02</span>
              <h3>Your data takes shape</h3>
              <p>Facts, relationships, activities, and evidence become one business context.</p>
            </div>
            <div className="sl-l-step">
              <span className="sl-l-step-num">03</span>
              <h3>Your AI goes live</h3>
              <p>Deploy agents and flows on schedules, webhooks, Slack, or demand.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="sl-l-section sl-l-outcome-section">
        <div className="sl-l-wrap sl-l-outcome-grid">
          <div>
            <div className="sl-l-eyebrow">— operational intelligence</div>
            <h2 className="sl-l-section-h">Not another chatbot.<br /><em>A system that does the work.</em></h2>
            <p className="sl-l-section-sub">Sublime combines historical reconstruction, live operational learning, and evidence-backed recommendations.</p>
            <div className="sl-l-outcome-list">
              <span><Sparkles /> Creates decision-ready artifacts, not skeletal summaries.</span>
              <span><BrainCircuit /> Remembers the context users provide across future runs.</span>
              <span><Zap /> Delivers through Slack or Gmail on the cadence you choose.</span>
            </div>
          </div>
          <div className="sl-l-artifact-card">
            <div className="sl-l-artifact-tabs"><b>REVENUE</b><span>MARKETING</span><span>OPERATIONS</span></div>
            <h3>Weekly pipeline intelligence</h3>
            <div className="sl-l-mini-metrics"><b>$1.2M <small>open pipeline</small></b><b>4 <small>deals at risk</small></b><b>92% <small>evidence mapped</small></b></div>
            <p>Two enterprise opportunities need executive action this week. Security review delays account for 68% of the value at risk.</p>
            <div className="sl-l-artifact-check">✓ Evidence gathered &nbsp; ✓ Owners assigned &nbsp; ✓ Delivered to #revenue</div>
          </div>
        </div>
      </section>

      <section className="sl-l-section sl-l-section--orange">
        <div className="sl-l-wrap sl-l-cta-band">
          <div>
            <div className="sl-l-eyebrow" style={{ color: 'var(--horizon-200)' }}>
              — get started
            </div>
            <h2 className="sl-l-section-h">Start using AI that <em>actually</em> works.</h2>
            <p className="sl-l-section-sub">Connect your tools and deploy your first business-ready agent today.</p>
          </div>
          <div className="sl-l-cta-row">
            <Link href="/auth/signup" className="sl-l-btn sl-l-btn--dark">
              Create an account →
            </Link>
            <Link href="/auth/login" className="sl-l-btn sl-l-btn--ghost">
              Sign in
            </Link>
          </div>
        </div>
      </section>

      <footer className="sl-l-footer">
        <div className="sl-l-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/sublime-lockup-black.svg" alt="Sublime" />
          <span className="sl-l-footer-tagline">see what&apos;s coming · know what to do</span>
          <span className="sl-l-nav-spacer" />
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/auth/login">Sign in</Link>
          <span>© 2026 Sublime</span>
        </div>
      </footer>
    </div>
  )
}
