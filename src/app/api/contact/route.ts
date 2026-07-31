import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiLogger } from '@/lib/logger'
import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { capabilitiesForPlan } from '@/lib/billing/capabilities'
import { entitlementPlanFor } from '@/lib/billing/entitlements'

export const dynamic = 'force-dynamic'
// Comfortably above the 30s Resend deadline so the timeout error path (a
// clean 502 with a fallback address) always runs before the platform kill.
export const maxDuration = 60

const CONTACT_INBOX = 'hello@trysublime.io'
const RESEND_API_URL = 'https://api.resend.com/emails'

const contactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  company: z.string().trim().max(200).optional().default(''),
  reason: z.enum(['enterprise', 'support', 'billing', 'privacy', 'feedback', 'other']),
  message: z.string().trim().min(1).max(5000),
  // Honeypot: real users never fill this hidden field. Bots that do get a
  // success response and no email — no signal that they were caught.
  website: z.string().max(0).optional().default(''),
})

const REASON_LABELS: Record<z.infer<typeof contactSchema>['reason'], string> = {
  enterprise: 'Sales & enterprise',
  support: 'Support',
  billing: 'Billing',
  privacy: 'Privacy & security',
  feedback: 'Feedback',
  other: 'Other',
}

// Public on purpose: the marketing /contact page serves signed-out visitors.
// Not wrapped in withAuthenticatedApi: no session is required, and unpaid
// users must still be able to reach sales and support.
export async function POST(request: NextRequest) {
  const parsed = contactSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Please fill in your name, a valid email, and a message.' }, { status: 400 })
  }
  const { name, email, company, reason, message, website } = parsed.data

  if (website) return NextResponse.json({ success: true })

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    apiLogger.error('contact form: RESEND_API_KEY is not configured — submission not deliverable')
    return NextResponse.json(
      { success: false, error: `Sending is temporarily unavailable — please email us directly at ${CONTACT_INBOX}.` },
      { status: 503 },
    )
  }

  const from = process.env.EMAIL_FROM || 'Sublime <onboarding@resend.dev>'
  const authenticated = await getAuthWithUser().catch(() => null)
  const organization = authenticated?.dbUser?.organization
  const plan = organization ? entitlementPlanFor(organization) : null
  const support = plan ? capabilitiesForPlan(plan).support : 'resources'
  const text = [
    `Reason: ${REASON_LABELS[reason]}`,
    `Support tier: ${support}`,
    plan ? `Plan: ${plan}` : null,
    authenticated?.organizationId ? `Workspace: ${authenticated.organizationId}` : null,
    `Name: ${name}`,
    `Email: ${email}`,
    company ? `Company: ${company}` : null,
    '',
    message,
  ].filter((line) => line !== null).join('\n')

  // 30s bound (matching every other Resend call site) + explicit maxDuration:
  // this was the one fetch in the repo with no signal at all.
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [CONTACT_INBOX],
      reply_to: email,
      subject: `[${support === 'dedicated' ? 'Dedicated' : support === 'priority' ? 'Priority' : 'Contact'}] ${REASON_LABELS[reason]} — ${name}`,
      text,
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    apiLogger.error('contact form: Resend send failed', { status: response.status, detail: detail.slice(0, 500) })
    return NextResponse.json(
      { success: false, error: `We could not send your message — please email us directly at ${CONTACT_INBOX}.` },
      { status: 502 },
    )
  }

  return NextResponse.json({ success: true })
}
