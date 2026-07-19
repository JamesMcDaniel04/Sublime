import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import Link from 'next/link'
import { ArrowRight, Mail } from 'lucide-react'
import { MarketingShell } from '@/components/landing/marketing-shell'
import '../landing.css'

const geist = Geist({ subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  title: 'Contact — Sublime',
  description: 'Get in touch with the Sublime team.',
}

const CONTACT_EMAIL = 'hello@trysublime.io'

const topics = [
  {
    title: 'General & support',
    desc: 'Questions about the product, your account, or anything else.',
    subject: 'Hello',
  },
  {
    title: 'Sales & enterprise',
    desc: 'Custom plans, security reviews, and bespoke integrations.',
    subject: 'Sublime Enterprise',
  },
  {
    title: 'Privacy & security',
    desc: 'Data requests, disclosures, or reporting a vulnerability.',
    subject: 'Privacy / Security',
  },
]

export default function ContactPage() {
  return (
    <MarketingShell fontClassName={geist.className}>
      {/* Hero */}
      <section className="px-6 border-b border-border">
        <div className="mx-auto max-w-[1200px] pt-20 pb-16">
          <p className="text-[12px] uppercase tracking-[0.15em] text-muted-foreground">Contact</p>
          <h1 className="mt-4 max-w-[560px] text-[clamp(2rem,4vw,3.2rem)] font-[500] leading-[1.08] tracking-[-0.04em] text-foreground">
            Talk to a real person.
          </h1>
          <p className="mt-6 max-w-[480px] text-base leading-relaxed text-muted-foreground">
            We read every message. Email us and someone on the team will get back to you, usually
            within one business day.
          </p>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="group mt-10 inline-flex items-center gap-3 border border-foreground/40 px-6 py-4 text-foreground transition-colors hover:bg-foreground hover:text-background"
          >
            <Mail className="h-4 w-4" />
            <span className="text-[15px] font-medium">{CONTACT_EMAIL}</span>
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </a>
        </div>
      </section>

      {/* Topics — bordered grid with pre-filled subjects */}
      <section className="px-6">
        <div className="mx-auto max-w-[1200px] py-16">
          <p className="text-[12px] uppercase tracking-[0.15em] text-muted-foreground">
            What&apos;s it about?
          </p>
          <div className="mt-8 border border-border">
            <div className="grid grid-cols-1 md:grid-cols-3">
              {topics.map((topic, i) => (
                <a
                  key={topic.title}
                  href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(topic.subject)}`}
                  className={`group p-8 transition-colors hover:bg-accent/40 ${
                    i < 2 ? 'md:border-r border-border' : ''
                  } ${i > 0 ? 'border-t md:border-t-0 border-border' : ''}`}
                >
                  <h2 className="flex items-center justify-between text-[13px] uppercase tracking-[0.15em] text-foreground">
                    {topic.title}
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-foreground" />
                  </h2>
                  <p className="mt-4 text-[13px] leading-[1.6] text-muted-foreground">{topic.desc}</p>
                </a>
              ))}
            </div>
          </div>
          <p className="mt-10 text-[13px] text-muted-foreground">
            Looking for our policies? Read the{' '}
            <Link
              href="/privacy"
              className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground transition-colors"
            >
              Privacy Policy
            </Link>{' '}
            and{' '}
            <Link
              href="/terms"
              className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground transition-colors"
            >
              Terms of Service
            </Link>
            .
          </p>
        </div>
      </section>
    </MarketingShell>
  )
}
