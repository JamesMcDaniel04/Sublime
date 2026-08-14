import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiLogger } from '@/lib/logger'
import { rateLimit } from '@/lib/ratelimit'
import { getAuthWithUser } from '@/lib/supabase/auth-utils'
import { capabilitiesForPlan } from '@/lib/billing/capabilities'
import { entitlementPlanFor } from '@/lib/billing/entitlements'
import { contactInbox, sendRawEmail } from '@/lib/email/send'
import { assertHumanToken, TurnstileError } from '@/lib/security/turnstile'
import { recordSecurityEvent } from '@/lib/security/alerts'

export const dynamic = 'force-dynamic'
// Comfortably above the 30s Resend deadline so the timeout error path (a
// clean 502 with a fallback address) always runs before the platform kill.
export const maxDuration = 60

const contactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  company: z.string().trim().max(200).optional().default(''),
  reason: z.enum(['enterprise', 'support', 'billing', 'privacy', 'feedback', 'other']),
  message: z.string().trim().min(1).max(5000),
  // Honeypot: real users never fill this hidden field. Bots that do get a
  // success response and no email — no signal that they were caught. Any
  // content must therefore VALIDATE (a max-length 400 would be the signal).
  website: z.string().max(2000).optional().default(''),
  // Solved Turnstile token. Optional in the schema because the field is absent
  // entirely when Turnstile is unconfigured; assertHumanToken decides whether
  // an absent token is acceptable.
  captchaToken: z.string().max(4000).optional(),
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
  const inbox = contactInbox()
  // Per-IP throttle before any other work — this is the only unauthenticated
  // POST that spends money (a Resend send per submission), and the honeypot
  // alone doesn't stop a scripted submitter. First x-forwarded-for hop is the
  // client on Vercel; 'unknown' shares one modest bucket rather than passing.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const limited = await rateLimit(`contact:${ip}`, { limit: 5, windowMs: 60_000 })
  if (!limited.ok) {
    return NextResponse.json(
      { success: false, error: `Too many messages — please wait a minute, or email us directly at ${inbox}.` },
      { status: 429 },
    )
  }

  const parsed = contactSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Please fill in your name, a valid email, and a message.' }, { status: 400 })
  }
  const { name, email, company, reason, message, website, captchaToken } = parsed.data

  if (website) return NextResponse.json({ success: true })

  // After the honeypot on purpose: a caught bot must keep getting the same
  // quiet success. Telling it "captcha failed" is the one response that would
  // teach it what to fix.
  try {
    await assertHumanToken(captchaToken, ip)
  } catch (error) {
    if (error instanceof TurnstileError) {
      // One failure is a human on a flaky connection. A burst of them is a bot
      // farm working the form, and that is the shape worth waking someone for.
      recordSecurityEvent({ kind: 'captcha.failed', source: ip, detail: { route: 'contact' } })
      return NextResponse.json({ success: false, error: error.message, code: 'CAPTCHA_FAILED' }, { status: 400 })
    }
    throw error
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    apiLogger.error('contact form: RESEND_API_KEY is not configured — submission not deliverable')
    return NextResponse.json(
      { success: false, error: `Sending is temporarily unavailable — please email us directly at ${inbox}.` },
      { status: 503 },
    )
  }

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

  try {
    await sendRawEmail({
      to: inbox, replyTo: email,
      subject: `[${support === 'dedicated' ? 'Dedicated' : support === 'priority' ? 'Priority' : 'Contact'}] ${REASON_LABELS[reason]} — ${name}`,
      text,
    })
  } catch (error) {
    apiLogger.error('contact form: Resend send failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { success: false, error: `We could not send your message — please email us directly at ${inbox}.` },
      { status: 502 },
    )
  }

  return NextResponse.json({ success: true })
}
