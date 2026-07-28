import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { MarketingShell } from '@/components/landing/marketing-shell'
import '../landing.css'

const geist = Geist({ subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  title: 'About — Sublime',
  description:
    'Sublime is the goal-based AI platform: it connects to your tech stack and deploys specialized agents measured against the goals your org runs on.',
}

const principles = [
  {
    title: 'Evidence over vibes',
    desc: 'Every agent run produces a log you can inspect, so you always know why an agent did what it did.',
  },
  {
    title: 'Your data stays yours',
    desc: 'Connections are explicitly authorized, scoped, and revocable, and we never train models on your data.',
  },
  {
    title: 'ROI over demos',
    desc: 'The first agent you deploy does real, attributable work against a goal you set — not a toy demo.',
  },
]

export default function AboutPage() {
  return (
    <MarketingShell fontClassName={geist.className}>
      {/* Hero */}
      <section className="px-6 border-b border-border">
        <div className="mx-auto max-w-[1200px] pt-20 pb-16">
          <p className="text-[12px] uppercase tracking-[0.15em] text-muted-foreground">About</p>
          <h1 className="mt-4 max-w-[640px] text-[clamp(2rem,4vw,3.2rem)] font-[500] leading-[1.08] tracking-[-0.04em] text-foreground">
            The goal-based AI platform.
          </h1>
          <p className="mt-6 max-w-[560px] text-base leading-relaxed text-muted-foreground">
            Sublime connects to the tools your team already uses: code, chat, docs, and
            project management. It connects the dots across them, then deploys specialized
            agents that automate repetitive work, cut costs, and surface process
            improvements — measured against the goals your org actually runs on.
          </p>
        </div>
      </section>

      {/* Why */}
      <section className="px-6 border-b border-border">
        <div className="mx-auto max-w-[1200px] py-16 lg:grid lg:grid-cols-[260px_1fr] lg:gap-16">
          <p className="text-[12px] uppercase tracking-[0.15em] text-muted-foreground">
            Why we built it
          </p>
          <div className="mt-4 lg:mt-0 max-w-[640px] space-y-4">
            <p className="text-[15px] leading-[1.7] text-muted-foreground">
              Most AI tools demo well and then stall, because nobody can say what they
              actually moved. Instead of a chatbot with no scoreboard, Sublime agents are
              deployed against goals — quota, ARR, a launch date — so their work is
              measured, not assumed.
            </p>
            <p className="text-[15px] leading-[1.7] text-muted-foreground">
              We believe the missing ingredient isn&apos;t a bigger model. It&apos;s
              accountability to outcomes. Sublime exists to close that gap: AI that plugs
              into real work, shows its evidence, and proves its ROI goal by goal.
            </p>
          </div>
        </div>
      </section>

      {/* Principles — bordered grid, echoing the pricing tiles */}
      <section className="px-6 border-b border-border">
        <div className="mx-auto max-w-[1200px] py-16">
          <p className="text-[12px] uppercase tracking-[0.15em] text-muted-foreground">
            How we work
          </p>
          <div className="mt-8 border border-border">
            <div className="grid grid-cols-1 md:grid-cols-3">
              {principles.map((principle, i) => (
                <div
                  key={principle.title}
                  className={`p-8 ${i < 2 ? 'md:border-r border-border' : ''} ${
                    i > 0 ? 'border-t md:border-t-0 border-border' : ''
                  }`}
                >
                  <h2 className="text-[13px] uppercase tracking-[0.15em] text-foreground">
                    {principle.title}
                  </h2>
                  <p className="mt-4 text-[13px] leading-[1.6] text-muted-foreground">
                    {principle.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA — mirrors the landing CTA */}
      <section className="px-6">
        <div className="mx-auto max-w-[1200px] pt-24 pb-32 text-center">
          <h2 className="mx-auto max-w-[560px] text-[clamp(1.6rem,3vw,2.4rem)] font-[500] tracking-[-0.035em] leading-[1.1] text-foreground">
            Get in touch.
          </h2>
          <p className="mx-auto mt-5 max-w-[400px] text-[15px] text-muted-foreground">
            Questions, feedback, or just curious? Reach us at{' '}
            <a
              href="mailto:hello@trysublime.io"
              className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground transition-colors"
            >
              hello@trysublime.io
            </a>{' '}
            or visit our{' '}
            <Link
              href="/contact"
              className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground transition-colors"
            >
              contact page
            </Link>
            .
          </p>
          <div className="mt-10 flex justify-center">
            <Link href="/auth/signup">
              <button className="group inline-flex items-center gap-2.5 px-8 py-3.5 text-[15px] font-medium transition-all duration-200 border border-foreground/40 text-foreground hover:bg-foreground hover:text-background hover:border-foreground">
                Create an account
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </button>
            </Link>
          </div>
        </div>
      </section>
    </MarketingShell>
  )
}
