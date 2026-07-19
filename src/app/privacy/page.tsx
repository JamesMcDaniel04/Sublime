import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Privacy Policy — Sublime',
  description: 'How Sublime collects, uses, and protects your data.',
}

const LAST_UPDATED = 'July 18, 2026'

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

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">1. Information We Collect</h2>
            <h3 className="text-xl font-medium mb-2">Account Information</h3>
            <p className="mb-4">
              When you create a Sublime account we collect your name, email address, and
              authentication credentials. If you subscribe to a paid plan, our payment processor
              (Stripe) collects your billing details; we never store full payment card numbers.
            </p>

            <h3 className="text-xl font-medium mb-2">Connected Tool Data</h3>
            <p className="mb-4">
              Sublime works by connecting to the tools your team already uses (for example GitHub,
              Slack, Google Workspace, and project management platforms). We only access this data
              after you explicitly authorize each connection, and only to the extent needed to run
              the agents and workflows you configure. You can revoke a connection at any time from
              your settings.
            </p>

            <h3 className="text-xl font-medium mb-2">Usage Data</h3>
            <p>
              We collect information about how you use Sublime — such as pages visited, features
              used, and agent run activity — to keep the service reliable and improve it.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">2. How We Use Your Information</h2>
            <ul className="list-disc list-inside space-y-2">
              <li>Provide, maintain, and improve the Sublime service</li>
              <li>Run the agents and workflows you configure, including AI-powered processing</li>
              <li>Process subscriptions and billing</li>
              <li>Send you technical notices, security alerts, and support messages</li>
              <li>Respond to your inquiries and provide customer support</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">3. AI Processing</h2>
            <p>
              Sublime uses third-party AI model providers to power agents and insights. Content is
              sent to these providers only as needed to fulfill the work you ask Sublime to do. We
              do not use your data to train our own models, and our providers are contractually
              restricted from using it to train theirs.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">4. Information Sharing</h2>
            <p>
              We do not sell your personal information. We share data only with service providers
              who help us operate Sublime (such as cloud hosting, payment processing, and AI model
              providers), when required by law, or with your consent.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">5. Data Security</h2>
            <p>
              We use industry-standard safeguards to protect your information, including encryption
              in transit and at rest, scoped OAuth access to connected tools, and access controls
              that limit who and what can read your data.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">6. Data Retention</h2>
            <p>
              We retain your information for as long as your account is active or as needed to
              provide the service. When you delete your account, or disconnect a tool, we delete
              the associated data within a reasonable period except where retention is required by
              law.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">7. Your Rights</h2>
            <p>
              You may access, update, export, or delete your personal information at any time. You
              can also opt out of non-essential communications. To exercise any of these rights,
              contact us at the address below.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">8. Third-Party Services</h2>
            <p>
              Sublime integrates with third-party platforms you choose to connect. This policy does
              not cover the privacy practices of those third parties; please review their policies
              directly.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">9. Changes to This Policy</h2>
            <p>
              We may update this privacy policy from time to time. We will post the new policy on
              this page and update the date above; for material changes we will notify you by
              email or in the product.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">10. Contact Us</h2>
            <p>
              If you have questions about this Privacy Policy, contact us at{' '}
              <a href="mailto:hello@trysublime.io" className="underline hover:text-foreground">
                hello@trysublime.io
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
