import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import Link from 'next/link'
import { MarketingShell } from '@/components/landing/marketing-shell'
import '../landing.css'

const geist = Geist({ subsets: ['latin'], display: 'swap' })

export const metadata: Metadata = {
  title: 'Privacy Policy — Sublime',
  description: 'How Sublime collects, uses, and protects your data.',
}

const LAST_UPDATED = 'July 19, 2026'

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[14px] leading-[1.7] text-muted-foreground">
      <span className="mt-[9px] h-1 w-1 rounded-full bg-primary shrink-0" />
      <span>{children}</span>
    </li>
  )
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-6 mb-2 text-[12px] uppercase tracking-[0.12em] text-foreground/80">{children}</h3>
  )
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="text-[14px] leading-[1.7] text-muted-foreground">{children}</p>
}

const sections: { id: string; title: string; body: React.ReactNode }[] = [
  {
    id: 'information-we-collect',
    title: 'Information we collect',
    body: (
      <>
        <SubHeading>Account information</SubHeading>
        <Body>
          When you create a Sublime account we collect your name, email address, and authentication
          credentials. If you sign in through a third-party identity provider, we receive the
          profile information that provider shares with us (such as your name, email address, and
          avatar). If you subscribe to a paid plan, our payment processor (Stripe) collects your
          billing details; we receive limited billing metadata (such as plan, subscription status,
          and the last four digits of your card) but never store full payment card numbers.
        </Body>
        <SubHeading>Connected tool data</SubHeading>
        <Body>
          Sublime works by connecting to the tools your team already uses, for example GitHub,
          Slack, Google Workspace, CRMs, and project management platforms. Each connection is
          established only after you explicitly authorize it through the provider&apos;s OAuth
          flow, and the access token is scoped to the permissions that provider grants. We access
          connected-tool content (such as messages, files, issues, and records) only to the extent
          needed to run the agents and workflows you configure, and to build the workspace context
          those agents rely on. You can revoke any connection at any time from your settings, which
          stops further access immediately.
        </Body>
        <SubHeading>Agent and workflow data</SubHeading>
        <Body>
          When you create and run agents or workflows, we store their configuration, inputs,
          outputs, and run logs. Run logs exist so you can inspect what an agent did and why. They
          are part of the product, and are retained under the same rules as the rest of your
          workspace data.
        </Body>
        <SubHeading>Usage and device data</SubHeading>
        <Body>
          We automatically collect information about how you use the Service, such as pages
          visited, features used, agent run activity, and error events, along with technical data
          like IP address, browser type, operating system, and timestamps. We use this to keep the
          Service secure and reliable, debug problems, and understand which features matter.
        </Body>
        <SubHeading>Communications</SubHeading>
        <Body>
          If you contact us (for example at hello@trysublime.io), we keep the correspondence and
          any information you choose to include so we can respond and improve support.
        </Body>
      </>
    ),
  },
  {
    id: 'how-we-use',
    title: 'How we use your information',
    body: (
      <>
        <ul className="space-y-2.5">
          <Bullet>Provide, operate, maintain, and improve the Service</Bullet>
          <Bullet>Run the agents and workflows you configure, including AI-powered processing</Bullet>
          <Bullet>Authenticate you and secure your account</Bullet>
          <Bullet>Process subscriptions, payments, and billing</Bullet>
          <Bullet>Send technical notices, security alerts, and support or administrative messages</Bullet>
          <Bullet>Respond to your inquiries and provide customer support</Bullet>
          <Bullet>Monitor for, prevent, and investigate fraud, abuse, and security incidents</Bullet>
          <Bullet>Analyze usage in aggregate to guide product decisions</Bullet>
          <Bullet>Comply with legal obligations</Bullet>
        </ul>
        <div className="mt-4">
          <Body>
            Where laws such as the GDPR apply, we process personal data on the legal bases of
            performance of our contract with you, our legitimate interests (such as securing and
            improving the Service), your consent (which you may withdraw at any time), and
            compliance with legal obligations.
          </Body>
        </div>
      </>
    ),
  },
  {
    id: 'ai-processing',
    title: 'AI processing',
    body: (
      <>
        <Body>
          Sublime uses third-party AI model providers (such as Anthropic) to power agents,
          workflows, and insights. Content, including relevant connected-tool data, is sent to
          these providers only as needed to fulfill the work you ask Sublime to do, over encrypted
          connections.
        </Body>
        <ul className="mt-4 space-y-2.5">
          <Bullet>We do not use your data to train our own models.</Bullet>
          <Bullet>Our AI providers are contractually restricted from using your data to train theirs.</Bullet>
          <Bullet>
            Agent outputs are stored in your workspace with run logs, so you can always see what
            was produced and from which inputs.
          </Bullet>
        </ul>
      </>
    ),
  },
  {
    id: 'cookies',
    title: 'Cookies and similar technologies',
    body: (
      <Body>
        We use cookies and similar technologies that are necessary to operate the Service,
        primarily to keep you signed in (session cookies) and to remember preferences such as your
        theme. We do not use third-party advertising cookies and we do not show ads. Because these
        cookies are strictly necessary, the Service will not function properly if you block them.
      </Body>
    ),
  },
  {
    id: 'sharing',
    title: 'How we share information',
    body: (
      <>
        <Body>
          We do not sell your personal information, and we do not share it with third parties for
          their own advertising purposes. We share information only in these situations:
        </Body>
        <ul className="mt-4 space-y-2.5">
          <Bullet>
            <strong className="text-foreground/90 font-medium">Service providers (subprocessors).</strong>{' '}
            Vendors that help us operate the Service: cloud hosting and databases, authentication,
            payment processing (Stripe), integration/OAuth infrastructure, AI model providers, and
            error monitoring. Each is bound by contract to use your data only to provide services
            to us.
          </Bullet>
          <Bullet>
            <strong className="text-foreground/90 font-medium">Your workspace.</strong> If you are
            part of a team workspace, your name and explicitly shared agents, flows, skills, and
            retained workspace knowledge are visible to the members you share them with. Private
            agents, runs, credentials, and settings remain scoped to their owner.
          </Bullet>
          <Bullet>
            <strong className="text-foreground/90 font-medium">Legal requirements.</strong> When
            required by law, subpoena, or other legal process, or when we believe disclosure is
            necessary to protect the rights, property, or safety of Sublime, our users, or the
            public.
          </Bullet>
          <Bullet>
            <strong className="text-foreground/90 font-medium">Business transfers.</strong> In
            connection with a merger, acquisition, or sale of assets, in which case we will notify
            you before your data becomes subject to a different privacy policy.
          </Bullet>
          <Bullet>
            <strong className="text-foreground/90 font-medium">With your consent.</strong> Any
            other sharing happens only when you direct or approve it.
          </Bullet>
        </ul>
      </>
    ),
  },
  {
    id: 'security',
    title: 'Data security',
    body: (
      <>
        <Body>We use industry-standard safeguards to protect your information, including:</Body>
        <ul className="mt-4 space-y-2.5">
          <Bullet>Encryption in transit (TLS) and at rest</Bullet>
          <Bullet>Application-level AES-256-GCM encryption for retained knowledge and stored secrets</Bullet>
          <Bullet>
            Scoped, revocable OAuth access to connected tools. We never ask for your passwords to
            those tools
          </Bullet>
          <Bullet>Access controls and least-privilege practices limiting who and what can read your data</Bullet>
          <Bullet>Isolation between customer workspaces</Bullet>
          <Bullet>Logging and monitoring for suspicious activity</Bullet>
        </ul>
        <div className="mt-4">
          <Body>
            No method of transmission or storage is completely secure, so we cannot guarantee
            absolute security. If we learn of a breach affecting your personal data, we will notify
            you and the relevant authorities as required by applicable law. To report a security
            vulnerability, contact us at hello@trysublime.io.
          </Body>
        </div>
      </>
    ),
  },
  {
    id: 'retention',
    title: 'Data retention',
    body: (
      <>
        <Body>
          We retain your information for as long as your account is active or as needed to provide
          the Service:
        </Body>
        <ul className="mt-4 space-y-2.5">
          <Bullet>
            <strong className="text-foreground/90 font-medium">Account data</strong> is kept while
            your account exists and deleted within a reasonable period after account deletion.
          </Bullet>
          <Bullet>
            <strong className="text-foreground/90 font-medium">Connected-tool data</strong>{' '}
            credentials and live access are deleted when you disconnect that tool. By default,
            redacted business context already learned from the connection remains as encrypted
            workspace knowledge until you delete it or the workspace.
          </Bullet>
          <Bullet>
            <strong className="text-foreground/90 font-medium">Run logs and workspace content</strong>{' '}
            may have large operational transcripts pruned on a schedule, but useful completed
            outcomes are promoted into encrypted retained knowledge first. Workspace-retained
            knowledge remains until it is deleted or the workspace is deleted.
          </Bullet>
          <Bullet>
            <strong className="text-foreground/90 font-medium">Billing records</strong> may be
            retained longer where tax, accounting, or other laws require it.
          </Bullet>
        </ul>
      </>
    ),
  },
  {
    id: 'your-rights',
    title: 'Your rights and choices',
    body: (
      <>
        <Body>
          Depending on where you live, you may have some or all of the following rights over your
          personal data:
        </Body>
        <ul className="mt-4 space-y-2.5">
          <Bullet>Access the personal data we hold about you</Bullet>
          <Bullet>Correct inaccurate or incomplete data</Bullet>
          <Bullet>Delete your data (&quot;right to be forgotten&quot;)</Bullet>
          <Bullet>Export your data in a portable format</Bullet>
          <Bullet>Restrict or object to certain processing</Bullet>
          <Bullet>Withdraw consent where processing is based on consent</Bullet>
          <Bullet>Not be discriminated against for exercising these rights</Bullet>
        </ul>
        <div className="mt-4">
          <Body>
            You can exercise many of these directly in the product: updating your profile,
            exporting or deleting retained knowledge, disconnecting tools, or deleting your account
            from settings. For anything else, email
            us at hello@trysublime.io and we will respond within the timeframe required by
            applicable law. If you are in the EEA or UK, you also have the right to lodge a
            complaint with your local data protection authority.
          </Body>
        </div>
      </>
    ),
  },
  {
    id: 'transfers',
    title: 'International data transfers',
    body: (
      <Body>
        Sublime is operated from the United States, and our service providers may process data in
        the United States and other countries. Where we transfer personal data from the EEA, UK, or
        Switzerland, we rely on appropriate safeguards such as Standard Contractual Clauses with
        our providers.
      </Body>
    ),
  },
  {
    id: 'children',
    title: 'Children’s privacy',
    body: (
      <Body>
        The Service is not directed to children under 16, and we do not knowingly collect personal
        information from them. If you believe a child has provided us personal information, contact
        us at hello@trysublime.io and we will delete it.
      </Body>
    ),
  },
  {
    id: 'third-parties',
    title: 'Third-party services',
    body: (
      <Body>
        Sublime integrates with third-party platforms you choose to connect, and the Service may
        link to third-party sites. This policy does not cover the privacy practices of those third
        parties; please review their policies directly. Your use of a connected tool remains
        governed by your agreement with that provider.
      </Body>
    ),
  },
  {
    id: 'changes',
    title: 'Changes to this policy',
    body: (
      <Body>
        We may update this privacy policy from time to time. We will post the new policy on this
        page and update the &quot;Last updated&quot; date above. For material changes, we will give
        you additional notice by email or in the product before the changes take effect. Continued
        use of the Service after changes take effect means you accept the updated policy.
      </Body>
    ),
  },
  {
    id: 'contact',
    title: 'Contact us',
    body: (
      <Body>
        If you have questions about this Privacy Policy or how we handle your data, contact us at{' '}
        <a
          href="mailto:hello@trysublime.io"
          className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground transition-colors"
        >
          hello@trysublime.io
        </a>
        , or reach us through our{' '}
        <Link
          href="/contact"
          className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground transition-colors"
        >
          contact page
        </Link>
        .
      </Body>
    ),
  },
]

export default function PrivacyPage() {
  return (
    <MarketingShell fontClassName={geist.className}>
      {/* Header */}
      <section className="px-6 border-b border-border">
        <div className="mx-auto max-w-[1200px] pt-20 pb-14">
          <p className="text-[12px] uppercase tracking-[0.15em] text-muted-foreground">Legal</p>
          <h1 className="mt-4 text-[clamp(2rem,4vw,3.2rem)] font-[500] leading-[1.08] tracking-[-0.04em] text-foreground">
            Privacy Policy
          </h1>
          <p className="mt-5 text-[13px] text-muted-foreground">Last updated: {LAST_UPDATED}</p>
          <p className="mt-6 max-w-[640px] text-[14px] leading-[1.7] text-muted-foreground">
            This Privacy Policy describes how Sublime (&quot;Sublime,&quot; &quot;we,&quot;
            &quot;us,&quot; or &quot;our&quot;) collects, uses, shares, and protects information
            when you use our website at trysublime.io and the Sublime application (together, the
            &quot;Service&quot;). By using the Service you agree to the practices described here.
            If you do not agree, please do not use the Service.
          </p>
        </div>
      </section>

      {/* Body: sticky section index + content */}
      <section className="px-6">
        <div className="mx-auto max-w-[1200px] lg:grid lg:grid-cols-[260px_1fr] lg:gap-16">
          {/* Section index */}
          <nav className="hidden lg:block border-r border-border">
            <div className="sticky top-[88px] py-12 pr-8">
              <ul className="space-y-3">
                {sections.map((section, i) => (
                  <li key={section.id}>
                    <a
                      href={`#${section.id}`}
                      className="group flex items-baseline gap-3 text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <span className="font-mono text-[11px] text-muted-foreground group-hover:text-foreground transition-colors">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      {section.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>

          {/* Sections */}
          <div className="py-12">
            {sections.map((section, i) => (
              <section
                key={section.id}
                id={section.id}
                className={`scroll-mt-[88px] ${i > 0 ? 'mt-12 border-t border-border pt-12' : ''}`}
              >
                <h2 className="flex items-baseline gap-4 text-[20px] font-[500] tracking-[-0.02em] text-foreground">
                  <span className="font-mono text-[13px] text-muted-foreground">
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
