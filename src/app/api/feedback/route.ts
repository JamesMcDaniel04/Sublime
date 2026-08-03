import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { contactInbox } from '@/lib/email/send'
import { sendLoggedEmail } from '@/lib/email/logged'
import { escapeHtml } from '@/lib/email/layout'
import { capabilitiesForPlan } from '@/lib/billing/capabilities'
import { afterResponse } from '@/lib/server/after-response'

export const runtime = 'nodejs'

const feedbackSchema = z.object({
  category: z.enum(['COMPLAINT', 'IDEA', 'QUESTION', 'OTHER']),
  message: z.string().trim().min(1).max(5000),
  path: z.string().trim().max(300).optional(),
})

/**
 * This workspace's own feedback, newest first.
 *
 * The email to the support inbox is the primary read path, but it is sent
 * best-effort AFTER the response — a bounced or failed send used to leave the
 * row reachable only by direct database access, with the submitter believing
 * it had been received. Admin-gated and org-scoped: a workspace reads its own
 * submissions and nobody else's.
 *
 * `message` is returned as the user typed it. Every current consumer renders
 * through React (which escapes by default); any future non-React surface —
 * an email, a CSV, an HTML export — must escape it explicitly.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit') ?? 50) || 50, 200)
  const submissions = await prisma.feedbackSubmission.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, category: true, message: true, path: true, createdAt: true, userId: true },
  })
  return { success: true, submissions }
}, { requires: 'insights:workspace' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`feedback:${auth.dbUser.id}`, { limit: 5, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many submissions — please wait a minute.', 429, 'RATE_LIMITED')
  const parsed = feedbackSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('Please choose a category and write a message.', 400, 'VALIDATION_ERROR')
  const { category, message, path } = parsed.data
  const submission = await prisma.feedbackSubmission.create({
    data: { organizationId: auth.organizationId, userId: auth.dbUser.id, category, message, path: path || null },
  })
  const support = capabilitiesForPlan(auth.plan).support
  const sender = auth.dbUser.email || 'unknown'
  afterResponse(() => sendLoggedEmail({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    emailKey: 'feedback', dedupeKey: `feedback:${submission.id}`,
    to: contactInbox(), replyTo: auth.dbUser.email || undefined,
    subject: `[${category === 'COMPLAINT' ? 'Complaint' : 'Feedback'}] ${support} — ${sender}`,
    html: [
      `<p><strong>Category:</strong> ${category}</p>`,
      `<p><strong>From:</strong> ${escapeHtml(sender)} (user ${escapeHtml(auth.dbUser.id)}, workspace ${escapeHtml(auth.organizationId)}, plan ${auth.plan})</p>`,
      path ? `<p><strong>Page:</strong> ${escapeHtml(path)}</p>` : '',
      `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>`,
    ].join(''),
  }))
  return { success: true, id: submission.id }
}, { requires: 'member' })
