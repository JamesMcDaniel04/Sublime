import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, ArrowRight } from 'lucide-react'

export const metadata: Metadata = {
  title: 'About — Sublime',
  description:
    'Sublime is an AI-agent workspace that connects to the tools your team already uses and delivers useful outcomes from day one.',
}

export default function AboutPage() {
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

        <div className="prose prose-gray max-w-none">
          <h1 className="text-4xl font-bold mb-8">About Sublime</h1>

          <p className="text-lg text-muted-foreground mb-8">
            AI that knows your business.
          </p>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">What we do</h2>
            <p className="mb-4">
              Sublime is an AI-agent workspace. You connect the tools your team already uses —
              code, chat, docs, and project management — and Sublime reconstructs how work
              actually gets done. From there it powers agents and workflows that deliver useful,
              evidence-backed outcomes from day one.
            </p>
            <p>
              Instead of a chatbot that starts from zero every conversation, Sublime agents start
              with your context: your repositories, your discussions, your processes.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Why we built it</h2>
            <p>
              Most AI tools demo well and then stall, because they don&apos;t understand the
              business they&apos;re dropped into. We believe the missing ingredient isn&apos;t a
              bigger model — it&apos;s context. Sublime exists to close that gap: to make AI that
              plugs into real work, shows its evidence, and earns trust run by run.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">How we work</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong>Evidence over vibes.</strong> Every agent run produces a log you can
                inspect, so you always know why an agent did what it did.
              </li>
              <li>
                <strong>Your data stays yours.</strong> Connections are explicitly authorized,
                scoped, and revocable — and we never train models on your data.
              </li>
              <li>
                <strong>Useful on day one.</strong> Templates and integrations are designed so the
                first agent you deploy does real work, not a toy demo.
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Get in touch</h2>
            <p className="mb-6">
              Questions, feedback, or just curious? Reach us at{' '}
              <a href="mailto:hello@trysublime.io" className="underline hover:text-foreground">
                hello@trysublime.io
              </a>{' '}
              or visit our <Link href="/contact" className="underline hover:text-foreground">contact page</Link>.
            </p>
            <Link
              href="/auth/signup"
              className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium border border-foreground/40 text-foreground hover:bg-foreground hover:text-background transition-colors"
            >
              Create an account
              <ArrowRight className="h-4 w-4" />
            </Link>
          </section>
        </div>
      </div>
    </div>
  )
}
