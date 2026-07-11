import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Bot, Cable, ScrollText } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import './landing.css'

// Rendered per-request: the try/catch around the Supabase auth check would
// otherwise swallow the dynamic-usage signal and bake a static page at build.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sublime — agents that show their work',
  description:
    'Build AI agents, connect them to the tools you already use, and read every run — each tool call, each result, each error, in plain sight.',
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
    <div className="sl-l-stage sl-l-rise sl-l-rise--3" role="img" aria-label="A Sublime run log: an agent's tool calls with results, one flagged error, and the run's output.">
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
          <div className="sl-l-eyebrow sl-l-rise">— the AI agent workspace</div>
          <h1 className="sl-l-h1 sl-l-rise">
            Agents that <em>show their work</em>.
          </h1>
          <p className="sl-l-lede sl-l-rise sl-l-rise--2">
            Sublime is where you build AI agents, connect them to the tools you already use, and read
            every run — each tool call, each result, each error, in plain sight.
          </p>
          <div className="sl-l-cta-row sl-l-rise sl-l-rise--2">
            <Link href="/auth/signup" className="sl-l-btn sl-l-btn--dark">
              Create your first agent →
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

      <section id="features" className="sl-l-section">
        <div className="sl-l-wrap">
          <div className="sl-l-eyebrow">— what you get</div>
          <h2 className="sl-l-section-h">The whole story of every run.</h2>
          <p className="sl-l-section-sub">
            Sublime keeps agents legible: what they were asked, which tools they touched, what came back, and
            what to do next.
          </p>
          <div className="sl-l-feature-grid">
            <div className="sl-l-feature">
              <span className="sl-l-feature-icon">
                <Bot size={18} strokeWidth={2} />
              </span>
              <h3>Build agents in minutes</h3>
              <p>
                Describe the objective in plain words. Attach reusable skills for tone, method, or format. Set a
                schedule, a webhook, or run it by hand.
              </p>
            </div>
            <div className="sl-l-feature">
              <span className="sl-l-feature-icon">
                <Cable size={18} strokeWidth={2} />
              </span>
              <h3>Connect the tools you already use</h3>
              <p>
                Gmail, Slack, HubSpot, Notion — through MCP servers and Pipedream connections scoped to your
                workspace. You approve every connection.
              </p>
            </div>
            <div className="sl-l-feature">
              <span className="sl-l-feature-icon">
                <ScrollText size={18} strokeWidth={2} />
              </span>
              <h3>Read every run</h3>
              <p>
                A timeline of tool calls, outputs, and errors for every execution. Ask a follow-up question and
                get an answer grounded in what actually happened.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="how" className="sl-l-section sl-l-section--blue">
        <div className="sl-l-wrap">
          <div className="sl-l-eyebrow">— how it works</div>
          <h2 className="sl-l-section-h">From idea to audited run.</h2>
          <div className="sl-l-steps">
            <div className="sl-l-step">
              <span className="sl-l-step-num">01</span>
              <h3>Describe the agent</h3>
              <p>An objective, a model, and the skills it should follow.</p>
            </div>
            <div className="sl-l-step">
              <span className="sl-l-step-num">02</span>
              <h3>Connect its tools</h3>
              <p>MCP and Pipedream integrations, approved by you.</p>
            </div>
            <div className="sl-l-step">
              <span className="sl-l-step-num">03</span>
              <h3>Run it</h3>
              <p>By hand, on a schedule, or from a webhook.</p>
            </div>
            <div className="sl-l-step">
              <span className="sl-l-step-num">04</span>
              <h3>Ask what happened</h3>
              <p>Chat with any run. The trace is the evidence.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="sl-l-section sl-l-section--dark">
        <div className="sl-l-wrap sl-l-cta-band">
          <div>
            <div className="sl-l-eyebrow" style={{ color: 'var(--horizon-200)' }}>
              — get started
            </div>
            <h2 className="sl-l-section-h">Stop wondering what your agents did.</h2>
            <p className="sl-l-section-sub">Create a workspace and read your first run today.</p>
          </div>
          <div className="sl-l-cta-row">
            <Link href="/auth/signup" className="sl-l-btn sl-l-btn--blue">
              Create an account →
            </Link>
            <Link href="/auth/login" className="sl-l-btn sl-l-btn--ghost-inverse">
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
