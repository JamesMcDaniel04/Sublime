import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { endpoint, keys } = z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }).parse(await request.json())

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
    },
    // The update path must rewrite organizationId along with userId: a browser
    // endpoint reused after switching accounts/workspaces would otherwise pin
    // the new user's subscription to the previous org (and the org-scoped
    // DELETE above could then never find it).
    update: { p256dh: keys.p256dh, auth: keys.auth, userId: auth.dbUser.id, organizationId: auth.organizationId },
  })
  return { success: true }
}, { requires: 'member' })

// Reconcile probe: is this browser's subscription endpoint actually
// registered for THIS user in THIS org? The bell previously trusted the
// browser's PushManager state alone, which reports "enabled" long after the
// server row was deleted (workspace teardown, account switch) — i.e. after
// notifications had silently stopped delivering.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const endpoint = request.nextUrl.searchParams.get('endpoint')
  if (!endpoint) return { success: true, registered: false }
  const count = await prisma.pushSubscription.count({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id, endpoint },
  })
  return { success: true, registered: count > 0 }
}, { requires: 'member' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const endpoint = request.nextUrl.searchParams.get('endpoint')
  if (endpoint) {
    await prisma.pushSubscription.deleteMany({ where: { organizationId: auth.organizationId, endpoint, userId: auth.dbUser.id } })
  }
  return { success: true }
}, { requires: 'member' })
