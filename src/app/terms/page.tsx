import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import Link from 'next/link'
import { MarketingShell } from '@/components/landing/marketing-shell'
import '../landing.css'

const geist = Geist({ subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  title: 'Terms of Service — Sublime',
  description: 'The terms that govern your use of Sublime.',
}

const LAST_UPDATED = 'July 20, 2026'

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[14px] leading-[1.7] text-muted-foreground">
      <span className="mt-[9px] h-1 w-1 rounded-full bg-primary shrink-0" />
      <span>{children}</span>
    </li>
  )
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="text-[14px] leading-[1.7] text-muted-foreground">{children}</p>
}

const sections: { id: string; title: string; body: React.ReactNode }[] = [
  {
    id: 'acceptance',
    title: 'Acceptance of terms',
    body: (
      <Body>
        These Terms of Service (&quot;Terms&quot;) are an agreement between you and Sublime
        (&quot;Sublime,&quot; &quot;we,&quot; &quot;us&quot;) governing your use of the Sublime
        website and application (the &quot;Service&quot;). By creating an account or using the
        Service you accept these Terms and our{' '}
        <Link href="/privacy" className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground transition-colors">
          Privacy Policy
        </Link>
        . If you are using Sublime on behalf of a company, you represent that you have authority
        to bind that company, and &quot;you&quot; means the company.
      </Body>
    ),
  },
  {
    id: 'service',
    title: 'Description of the service',
    body: (
      <Body>
        Sublime is the goal-based AI platform: you connect the tools your team already uses, and
        Sublime deploys specialized agents and multi-step workflows (&quot;flows&quot;) that act
        on your behalf across those tools, with evidence-backed run logs, measured against the
        goals your org runs on. Features vary by plan and may evolve over time.
      </Body>
    ),
  },
  {
    id: 'accounts',
    title: 'Accounts and eligibility',
    body: (
      <>
        <Body>To use Sublime you must:</Body>
        <ul className="mt-4 space-y-2.5">
          <Bullet>Be at least 16 years old and able to form a binding contract.</Bullet>
          <Bullet>Provide accurate account information and keep it current.</Bullet>
          <Bullet>
            Keep your credentials confidential. You are responsible for all activity under your
            account. Tell us immediately at hello@trysublime.io if you suspect unauthorized use.
          </Bullet>
        </ul>
      </>
    ),
  },
  {
    id: 'billing',
    title: 'Subscriptions and billing',
    body: (
      <>
        <ul className="space-y-2.5">
          <Bullet>
            <strong className="text-foreground/90 font-medium">Subscriptions.</strong> Paid plans
            start and bill monthly in advance through Stripe from the day you subscribe, then renew
            automatically until canceled. Taxes may apply based on your location.
          </Bullet>
          <Bullet>
            <strong className="text-foreground/90 font-medium">Cancellation.</strong> You can
            cancel anytime from Settings → Billing (via the Stripe billing portal). Cancellation
            takes effect at the end of the current billing period; we do not prorate partial
            months except where the law requires it.
          </Bullet>
          <Bullet>
            <strong className="text-foreground/90 font-medium">Price changes.</strong> We may
            change prices with at least 30 days&apos; notice; changes apply from your next renewal.
          </Bullet>
        </ul>
      </>
    ),
  },
  {
    id: 'limits',
    title: 'Plan limits and fair use',
    body: (
      <>
        <Body>
          Each plan includes defined allowances: seats, monthly credits (1 credit = 1,000 AI
          tokens, pooled across your workspace), and caps on agents, flows, and integrations, as
          described on our pricing page. When you reach an allowance, the related capability
          pauses until you upgrade or the monthly allowance resets.
        </Body>
        <div className="mt-4">
          <Body>
            You may not circumvent limits (for example by splitting one team across multiple
            Individual accounts to avoid per-seat pricing or automating account creation to evade
            billing). We may apply reasonable technical safeguards against usage that degrades
            the Service for others.
          </Body>
        </div>
      </>
    ),
  },
  {
    id: 'acceptable-use',
    title: 'Acceptable use',
    body: (
      <>
        <Body>You agree not to use the Service to:</Body>
        <ul className="mt-4 space-y-2.5">
          <Bullet>Violate any law, or infringe anyone&apos;s rights (including privacy and IP rights).</Bullet>
          <Bullet>Send spam or unsolicited messages through connected tools, or misrepresent who a message is from.</Bullet>
          <Bullet>Upload malware, probe or disrupt our infrastructure, or access another customer&apos;s data.</Bullet>
          <Bullet>Reverse engineer the Service or use it to build a directly competing product.</Bullet>
          <Bullet>Resell or sublicense access without our written agreement.</Bullet>
        </ul>
        <div className="mt-4">
          <Body>We may suspend accounts engaged in these activities, with notice where practicable.</Body>
        </div>
      </>
    ),
  },
  {
    id: 'your-content',
    title: 'Your content and data',
    body: (
      <>
        <Body>
          You own your data: the content you upload, the data flowing from your connected tools,
          your agent and flow configurations, and the outputs your agents produce for you. You
          grant us the limited license needed to host, process, and transmit that content solely
          to operate and support the Service, as described in the{' '}
          <Link href="/privacy" className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground transition-colors">
            Privacy Policy
          </Link>
          . We do not use your data to train models.
        </Body>
        <div className="mt-4">
          <Body>
            You are responsible for having the necessary rights to the data you connect, and for
            your compliance with the terms of each third-party tool you authorize.
          </Body>
        </div>
      </>
    ),
  },
  {
    id: 'ai-outputs',
    title: 'AI outputs and automation',
    body: (
      <>
        <ul className="space-y-2.5">
          <Bullet>
            AI-generated output may be inaccurate, incomplete, or unsuitable for your purpose.
            Review it before relying on it for consequential decisions.
          </Bullet>
          <Bullet>
            Agents and flows act with the permissions you give them. You are responsible for the
            actions they take in your connected tools, including messages sent and records
            created; features like approval gates and run logs exist so you can supervise them.
          </Bullet>
          <Bullet>
            The Service is not designed for use where failure could lead to death, personal
            injury, or severe damage (medical, legal, or financial advice delivered without human
            review; safety-critical systems).
          </Bullet>
        </ul>
      </>
    ),
  },
  {
    id: 'third-party',
    title: 'Third-party services',
    body: (
      <Body>
        The Service integrates with third-party platforms you choose to connect and relies on
        third-party providers (cloud hosting, AI models, payments). Your use of a connected tool
        remains governed by that provider&apos;s own terms, and we are not responsible for
        third-party services, their availability, or changes to their APIs that affect an
        integration. You can revoke any connection at any time from your settings.
      </Body>
    ),
  },
  {
    id: 'ip',
    title: 'Our intellectual property',
    body: (
      <Body>
        Sublime and its software, design, and branding are owned by us and our licensors. We grant
        you a limited, non-exclusive, non-transferable right to use the Service under these Terms.
        Feedback you send us may be used to improve the Service without obligation to you.
      </Body>
    ),
  },
  {
    id: 'availability',
    title: 'Availability and changes to the service',
    body: (
      <Body>
        We work to keep the Service available and performant, but it is provided without a
        guaranteed uptime level (enterprise SLAs are available; contact sales). We may change,
        add, or remove features; if a change materially reduces core functionality you paid for,
        you may cancel and receive a prorated refund of prepaid, unused fees.
      </Body>
    ),
  },
  {
    id: 'termination',
    title: 'Termination',
    body: (
      <>
        <ul className="space-y-2.5">
          <Bullet>
            <strong className="text-foreground/90 font-medium">By you:</strong> stop using the
            Service and delete your workspace at any time from settings; deletion of data follows
            the retention rules in the Privacy Policy.
          </Bullet>
          <Bullet>
            <strong className="text-foreground/90 font-medium">By us:</strong> we may suspend or
            terminate access for material breach of these Terms, non-payment, or where required by
            law, with notice and a chance to cure where practicable.
          </Bullet>
          <Bullet>
            Sections that by their nature should survive termination (payment obligations, IP,
            disclaimers, liability limits) survive.
          </Bullet>
        </ul>
      </>
    ),
  },
  {
    id: 'disclaimers',
    title: 'Disclaimers and limitation of liability',
    body: (
      <>
        <Body>
          THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE,&quot; WITHOUT
          WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
        </Body>
        <div className="mt-4">
          <Body>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER PARTY IS LIABLE FOR INDIRECT,
            INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR LOST PROFITS OR DATA; AND
            OUR TOTAL LIABILITY UNDER THESE TERMS IS CAPPED AT THE FEES YOU PAID US IN THE 12
            MONTHS BEFORE THE CLAIM. NOTHING IN THESE TERMS EXCLUDES LIABILITY THAT CANNOT BE
            EXCLUDED BY LAW.
          </Body>
        </div>
      </>
    ),
  },
  {
    id: 'indemnification',
    title: 'Indemnification',
    body: (
      <Body>
        You will defend and indemnify Sublime against third-party claims arising from your content,
        your use of the Service in violation of these Terms, or your violation of law or
        third-party rights, and we will defend and indemnify you against third-party claims that
        the Service itself infringes their intellectual property.
      </Body>
    ),
  },
  {
    id: 'law',
    title: 'Governing law and disputes',
    body: (
      <Body>
        These Terms are governed by the laws of the State of Delaware, USA, excluding its conflict
        of law rules. Before filing a claim, contact us at hello@trysublime.io first; most disputes can
        be resolved informally. Any claim must be brought within one year of when it arose, where
        the law allows.
      </Body>
    ),
  },
  {
    id: 'changes',
    title: 'Changes to these terms',
    body: (
      <Body>
        We may update these Terms from time to time. We will post the new version on this page and
        update the date above; for material changes we will give you advance notice by email or in
        the product. Continued use after changes take effect means you accept the updated Terms.
      </Body>
    ),
  },
  {
    id: 'contact',
    title: 'Contact',
    body: (
      <Body>
        Questions about these Terms? Email{' '}
        <a href="mailto:hello@trysublime.io" className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground transition-colors">
          hello@trysublime.io
        </a>{' '}
        or use our{' '}
        <Link href="/contact" className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground transition-colors">
          contact page
        </Link>
        .
      </Body>
    ),
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
          <p className="mt-6 max-w-[640px] text-[14px] leading-[1.7] text-muted-foreground">
            The short version: you own your data, agents act only with the access you give them,
            subscriptions begin when you check out and can be canceled anytime, and we expect fair
            use of the platform. The full terms follow.
          </p>
        </div>
      </section>

      {/* Body: sticky section index + content */}
      <section className="px-6">
        <div className="mx-auto max-w-[1200px] lg:grid lg:grid-cols-[260px_1fr] lg:gap-16">
          <nav className="hidden lg:block border-r border-border">
            <div className="sticky top-[88px] py-12 pr-8">
              <ul className="space-y-3">
                {sections.map((section, i) => (
                  <li key={section.id}>
                    <a
                      href={`#${section.id}`}
                      className="group flex items-baseline gap-3 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <span className="font-mono text-[11px] text-muted-foreground/60 group-hover:text-foreground/60 transition-colors">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      {section.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>

          <div className="py-12">
            {sections.map((section, i) => (
              <section
                key={section.id}
                id={section.id}
                className={`scroll-mt-[88px] ${i > 0 ? 'mt-12 border-t border-border pt-12' : ''}`}
              >
                <h2 className="flex items-baseline gap-4 text-[20px] font-[500] tracking-[-0.02em] text-foreground">
                  <span className="font-mono text-[13px] text-muted-foreground/60">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {section.title}
                </h2>
                <div className="mt-5 max-w-[680px]">{section.body}</div>
              </section>
            ))}
          </div>
        </div>
      </section>
    </MarketingShell>
  )
}
