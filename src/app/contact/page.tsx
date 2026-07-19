import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, Mail } from 'lucide-react'

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
    <div className="min-h-screen bg-background py-12 px-4">
      <div className="container mx-auto max-w-4xl">
        <Link
          href="/"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to home
        </Link>

        <h1 className="text-4xl font-bold mb-4">Contact Us</h1>
        <p className="text-lg text-muted-foreground mb-10 max-w-2xl">
          We read every message. Email us and a real person on the team will get back to you,
          usually within one business day.
        </p>

        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className="inline-flex items-center gap-3 border border-foreground/40 px-6 py-4 text-foreground hover:bg-foreground hover:text-background transition-colors mb-12"
        >
          <Mail className="h-5 w-5" />
          <span className="text-lg font-medium">{CONTACT_EMAIL}</span>
        </a>

        <div className="grid grid-cols-1 md:grid-cols-3 border border-border">
          {topics.map((topic, i) => (
            <a
              key={topic.title}
              href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(topic.subject)}`}
              className={`p-6 hover:bg-accent/40 transition-colors ${
                i > 0 ? 'border-t md:border-t-0 md:border-l border-border' : ''
              }`}
            >
              <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-foreground mb-2">
                {topic.title}
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{topic.desc}</p>
            </a>
          ))}
        </div>

        <p className="mt-10 text-sm text-muted-foreground">
          Looking for our policies? Read the{' '}
          <Link href="/privacy" className="underline hover:text-foreground">
            Privacy Policy
          </Link>{' '}
          and{' '}
          <Link href="/terms" className="underline hover:text-foreground">
            Terms of Service
          </Link>
          .
        </p>
      </div>
    </div>
  )
}
