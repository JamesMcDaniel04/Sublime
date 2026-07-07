import webpush from 'web-push'
import { prisma } from '@/lib/prisma'

let configured = false

function ensureConfigured(): boolean {
  if (configured) return true
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) return false
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:notifications@den.app', publicKey, privateKey)
  configured = true
  return true
}

export function pushEnabled(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
}

export type PushPayload = { title: string; body?: string; url?: string }

// Best-effort web push to all of a user's registered devices. No-op when VAPID
// keys aren't configured, so in-app notifications still work without push.
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) return
  const subs = await prisma.pushSubscription.findMany({ where: { userId } })
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        )
      } catch (error) {
        const status = (error as { statusCode?: number })?.statusCode
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {})
        }
      }
    }),
  )
}
