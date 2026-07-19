import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import { MarketingShell } from '@/components/landing/marketing-shell'
import '../landing.css'

const geist = Geist({ subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  title: 'Terms of Service — Sublime',
  description: 'The terms that govern your use of Sublime.',
}

const LAST_UPDATED = 'July 19, 2026'

const sections: { title: string; body: string }[] = [
  {
    title: 'Acceptance of terms',
    body: 'By accessing and using Sublime, you accept and agree to be bound by the terms and provision of this agreement.',
  },
  {
    title: 'Description of service',
    body: 'Sublime is an AI-agent workspace that lets teams build, run, and review agents connected to their tools, reporting, and insights for software development teams.',
  },
  {
    title: 'User accounts',
    body: 'You are responsible for maintaining the confidentiality of your account and password and for restricting access to your computer.',
  },
  {
    title: 'Data and privacy',
    body: 'We collect and process data in accordance with our Privacy Policy. By using our service, you consent to the collection and use of information as outlined in our Privacy Policy.',
  },
  {
    title: 'Prohibited uses',
    body: 'You may not use Sublime for any unlawful purpose or to solicit others to perform unlawful acts.',
  },
  {
    title: 'Termination',
    body: 'We may terminate your access to the service at any time, without cause or notice.',
  },
  {
    title: 'Limitation of liability',
    body: 'Sublime shall not be liable for any indirect, incidental, special, consequential, or punitive damages.',
  },
  {
    title: 'Contact information',
    body: 'For questions about these Terms of Service, please contact us at hello@trysublime.io.',
  },
]

export default function TermsPage() {
  return (
    <MarketingShell fontClassName={geist.className}>
      {/* Header */}
      <section className="px-6 border-b border-border">
        <div className="mx-auto max-w-[1200px] pt-20 pb-14">
          <p className="text-[12px] uppercase tracking-[0.15em] text-muted-foreground">Legal</p>
          <h1 className="mt-4 text-[clamp(2rem,4vw,3.2rem)] font-[500] leading-[1.08] tracking-[-0.04em] text-foreground">
            Terms of Service
          </h1>
          <p className="mt-5 text-[13px] text-muted-foreground">Last updated: {LAST_UPDATED}</p>
        </div>
      </section>

      {/* Sections */}
      <section className="px-6">
        <div className="mx-auto max-w-[1200px] py-12">
          {sections.map((section, i) => (
            <section key={section.title} className={i > 0 ? 'mt-12 border-t border-border pt-12' : ''}>
              <h2 className="flex items-baseline gap-4 text-[20px] font-[500] tracking-[-0.02em] text-foreground">
                <span className="font-mono text-[13px] text-muted-foreground/60">
                  {String(i + 1).padStart(2, '0')}
                </span>
                {section.title}
              </h2>
              <p className="mt-5 max-w-[680px] text-[14px] leading-[1.7] text-muted-foreground">
                {section.body}
              </p>
            </section>
          ))}
        </div>
      </section>
    </MarketingShell>
  )
}
