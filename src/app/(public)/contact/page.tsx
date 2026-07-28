import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import { Suspense } from 'react'
import Link from 'next/link'
import { Mail } from 'lucide-react'
import { MarketingShell } from '@/components/landing/marketing-shell'
import { ContactForm } from '@/components/marketing/contact-form'
import '../landing.css'

const geist = Geist({ subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  title: 'Contact — Sublime',
  description: 'Get in touch with the Sublime team.',
}

const CONTACT_EMAIL = 'hello@trysublime.io'

export default function ContactPage() {
  return (
    <MarketingShell fontClassName={geist.className}>
      {/* Hero */}
      <section className="px-6 border-b border-border">
        <div className="mx-auto max-w-[1200px] pt-20 pb-14">
          <p className="text-[12px] uppercase tracking-[0.15em] text-muted-foreground">Contact</p>
          <h1 className="mt-4 max-w-[560px] text-[clamp(2rem,4vw,3.2rem)] font-[500] leading-[1.08] tracking-[-0.04em] text-foreground">
            Talk to a real person.
          </h1>
          <p className="mt-6 max-w-[480px] text-base leading-relaxed text-muted-foreground">
            We read every message. Send us a note and someone on the team will get back to you,
            usually within one business day.
          </p>
        </div>
      </section>

      {/* Form + direct email */}
      <section className="px-6">
        <div className="mx-auto max-w-[1200px] py-16 lg:grid lg:grid-cols-[1fr_320px] lg:gap-16">
          <Suspense fallback={null}>
            <ContactForm />
          </Suspense>
          <aside className="mt-10 lg:mt-0">
            <p className="text-[12px] uppercase tracking-[0.15em] text-muted-foreground">
              Prefer email?
            </p>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="mt-4 inline-flex items-center gap-2.5 border border-foreground/40 px-5 py-3 text-foreground transition-colors hover:bg-foreground hover:text-background"
            >
              <Mail className="h-4 w-4" />
              <span className="text-[14px] font-medium">{CONTACT_EMAIL}</span>
            </a>
            <p className="mt-8 text-[13px] leading-[1.6] text-muted-foreground">
              Looking for our policies? Read the{' '}
              <Link href="/privacy" className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground transition-colors">
                Privacy Policy
              </Link>{' '}
              and{' '}
              <Link href="/terms" className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground transition-colors">
                Terms of Service
              </Link>
              .
            </p>
          </aside>
        </div>
      </section>
    </MarketingShell>
  )
}
