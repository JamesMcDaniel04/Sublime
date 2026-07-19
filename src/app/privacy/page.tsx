import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Privacy Policy — Sublime',
  description: 'How Sublime collects, uses, and protects your data.',
}

const LAST_UPDATED = 'July 19, 2026'

export default function PrivacyPage() {
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
          <h1 className="text-4xl font-bold mb-8">Privacy Policy</h1>

          <p className="text-lg text-muted-foreground mb-8">Last updated: {LAST_UPDATED}</p>

          <p className="mb-8">
            This Privacy Policy describes how Sublime (&quot;Sublime,&quot; &quot;we,&quot;
            &quot;us,&quot; or &quot;our&quot;) collects, uses, shares, and protects information
            when you use our website at trysublime.io and the Sublime application (together, the
            &quot;Service&quot;). By using the Service you agree to the practices described here.
            If you do not agree, please do not use the Service.
          </p>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">1. Information We Collect</h2>

            <h3 className="text-xl font-medium mb-2">Account Information</h3>
            <p className="mb-4">
              When you create a Sublime account we collect your name, email address, and
              authentication credentials. If you sign in through a third-party identity provider,
              we receive the profile information that provider shares with us (such as your name,
              email address, and avatar). If you subscribe to a paid plan, our payment processor
              (Stripe) collects your billing details; we receive limited billing metadata (such as
              plan, subscription status, and the last four digits of your card) but never store
              full payment card numbers.
            </p>

            <h3 className="text-xl font-medium mb-2">Connected Tool Data</h3>
            <p className="mb-4">
              Sublime works by connecting to the tools your team already uses — for example
              GitHub, Slack, Google Workspace, CRMs, and project management platforms. Each
              connection is established only after you explicitly authorize it through the
              provider&apos;s OAuth flow, and the access token is scoped to the permissions that
              provider grants. We access connected-tool content (such as messages, files, issues,
              and records) only to the extent needed to run the agents and workflows you
              configure, and to build the workspace context those agents rely on. You can revoke
              any connection at any time from your settings, which stops further access
              immediately.
            </p>

            <h3 className="text-xl font-medium mb-2">Agent and Workflow Data</h3>
            <p className="mb-4">
              When you create and run agents or workflows, we store their configuration, inputs,
              outputs, and run logs. Run logs exist so you can inspect what an agent did and why —
              they are part of the product, and are retained under the same rules as the rest of
              your workspace data.
            </p>

            <h3 className="text-xl font-medium mb-2">Usage and Device Data</h3>
            <p className="mb-4">
              We automatically collect information about how you use the Service, such as pages
              visited, features used, agent run activity, and error events, along with technical
              data like IP address, browser type, operating system, and timestamps. We use this to
              keep the Service secure and reliable, debug problems, and understand which features
              matter.
            </p>

            <h3 className="text-xl font-medium mb-2">Communications</h3>
            <p>
              If you contact us (for example at hello@trysublime.io), we keep the correspondence
              and any information you choose to include so we can respond and improve support.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">2. How We Use Your Information</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>Provide, operate, maintain, and improve the Service</li>
              <li>Run the agents and workflows you configure, including AI-powered processing</li>
              <li>Authenticate you and secure your account</li>
              <li>Process subscriptions, payments, and billing</li>
              <li>Send technical notices, security alerts, and support or administrative messages</li>
              <li>Respond to your inquiries and provide customer support</li>
              <li>Monitor for, prevent, and investigate fraud, abuse, and security incidents</li>
              <li>Analyze usage in aggregate to guide product decisions</li>
              <li>Comply with legal obligations</li>
            </ul>
            <p className="mt-4">
              Where laws such as the GDPR apply, we process personal data on the legal bases of
              performance of our contract with you, our legitimate interests (such as securing and
              improving the Service), your consent (which you may withdraw at any time), and
              compliance with legal obligations.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">3. AI Processing</h2>
            <p className="mb-4">
              Sublime uses third-party AI model providers (such as Anthropic) to power agents,
              workflows, and insights. Content — including relevant connected-tool data — is sent
              to these providers only as needed to fulfill the work you ask Sublime to do, over
              encrypted connections.
            </p>
            <ul className="list-disc list-inside space-y-2">
              <li>We do not use your data to train our own models.</li>
              <li>
                Our AI providers are contractually restricted from using your data to train
                theirs.
              </li>
              <li>
                Agent outputs are stored in your workspace with run logs, so you can always see
                what was produced and from which inputs.
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">4. Cookies and Similar Technologies</h2>
            <p>
              We use cookies and similar technologies that are necessary to operate the Service —
              primarily to keep you signed in (session cookies) and to remember preferences such
              as your theme. We do not use third-party advertising cookies and we do not show
              ads. Because these cookies are strictly necessary, the Service will not function
              properly if you block them.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">5. How We Share Information</h2>
            <p className="mb-4">
              We do not sell your personal information, and we do not share it with third parties
              for their own advertising purposes. We share information only in these situations:
            </p>
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong>Service providers (subprocessors).</strong> Vendors that help us operate
                the Service — cloud hosting and databases, authentication, payment processing
                (Stripe), integration/OAuth infrastructure, AI model providers, and error
                monitoring. Each is bound by contract to use your data only to provide services to
                us.
              </li>
              <li>
                <strong>Your workspace.</strong> If you are part of a team workspace, your name,
                activity, and the agents and runs you create are visible to other members of that
                workspace as part of normal collaboration.
              </li>
              <li>
                <strong>Legal requirements.</strong> When required by law, subpoena, or other
                legal process, or when we believe disclosure is necessary to protect the rights,
                property, or safety of Sublime, our users, or the public.
              </li>
              <li>
                <strong>Business transfers.</strong> In connection with a merger, acquisition, or
                sale of assets, in which case we will notify you before your data becomes subject
                to a different privacy policy.
              </li>
              <li>
                <strong>With your consent.</strong> Any other sharing happens only when you direct
                or approve it.
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">6. Data Security</h2>
            <p className="mb-4">
              We use industry-standard safeguards to protect your information, including:
            </p>
            <ul className="list-disc list-inside space-y-2">
              <li>Encryption in transit (TLS) and at rest</li>
              <li>Scoped, revocable OAuth access to connected tools — we never ask for your passwords to those tools</li>
              <li>Access controls and least-privilege practices limiting who and what can read your data</li>
              <li>Isolation between customer workspaces</li>
              <li>Logging and monitoring for suspicious activity</li>
            </ul>
            <p className="mt-4">
              No method of transmission or storage is completely secure, so we cannot guarantee
              absolute security. If we learn of a breach affecting your personal data, we will
              notify you and the relevant authorities as required by applicable law. To report a
              security vulnerability, contact us at hello@trysublime.io.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">7. Data Retention</h2>
            <p className="mb-4">
              We retain your information for as long as your account is active or as needed to
              provide the Service:
            </p>
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong>Account data</strong> is kept while your account exists and deleted within
                a reasonable period after account deletion.
              </li>
              <li>
                <strong>Connected-tool data</strong> associated with a connection is deleted when
                you disconnect that tool or delete your account.
              </li>
              <li>
                <strong>Run logs and workspace content</strong> are kept while the workspace
                exists so your team retains its audit history, and removed when the workspace or
                account is deleted.
              </li>
              <li>
                <strong>Billing records</strong> may be retained longer where tax, accounting, or
                other laws require it.
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">8. Your Rights and Choices</h2>
            <p className="mb-4">
              Depending on where you live, you may have some or all of the following rights over
              your personal data:
            </p>
            <ul className="list-disc list-inside space-y-2">
              <li>Access the personal data we hold about you</li>
              <li>Correct inaccurate or incomplete data</li>
              <li>Delete your data (&quot;right to be forgotten&quot;)</li>
              <li>Export your data in a portable format</li>
              <li>Restrict or object to certain processing</li>
              <li>Withdraw consent where processing is based on consent</li>
              <li>Not be discriminated against for exercising these rights</li>
            </ul>
            <p className="mt-4">
              You can exercise many of these directly in the product — updating your profile,
              disconnecting tools, or deleting your account from settings. For anything else,
              email us at hello@trysublime.io and we will respond within the timeframe required by
              applicable law. If you are in the EEA or UK, you also have the right to lodge a
              complaint with your local data protection authority.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">9. International Data Transfers</h2>
            <p>
              Sublime is operated from the United States, and our service providers may process
              data in the United States and other countries. Where we transfer personal data from
              the EEA, UK, or Switzerland, we rely on appropriate safeguards such as Standard
              Contractual Clauses with our providers.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">10. Children&apos;s Privacy</h2>
            <p>
              The Service is not directed to children under 16, and we do not knowingly collect
              personal information from them. If you believe a child has provided us personal
              information, contact us at hello@trysublime.io and we will delete it.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">11. Third-Party Services</h2>
            <p>
              Sublime integrates with third-party platforms you choose to connect, and the
              Service may link to third-party sites. This policy does not cover the privacy
              practices of those third parties; please review their policies directly. Your use of
              a connected tool remains governed by your agreement with that provider.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">12. Changes to This Policy</h2>
            <p>
              We may update this privacy policy from time to time. We will post the new policy on
              this page and update the &quot;Last updated&quot; date above. For material changes,
              we will give you additional notice by email or in the product before the changes
              take effect. Continued use of the Service after changes take effect means you accept
              the updated policy.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">13. Contact Us</h2>
            <p>
              If you have questions about this Privacy Policy or how we handle your data, contact
              us at{' '}
              <a href="mailto:hello@trysublime.io" className="underline hover:text-foreground">
                hello@trysublime.io
              </a>. You can also reach us through our{' '}
              <Link href="/contact" className="underline hover:text-foreground">
                contact page
              </Link>.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
