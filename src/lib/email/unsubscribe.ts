import crypto from 'node:crypto'

function secret(): string | null {
  return process.env.EMAIL_LINK_SECRET || process.env.CRON_SECRET || null
}
function sign(userId: string, key: string): string {
  return crypto.createHmac('sha256', key).update(`email-unsubscribe:${userId}`).digest('base64url')
}
export function unsubscribeUrl(userId: string): string | null {
  const key = secret()
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!key || !appUrl) return null
  return `${appUrl.replace(/\/$/, '')}/api/email/unsubscribe?uid=${encodeURIComponent(userId)}&sig=${sign(userId, key)}`
}
export function verifyUnsubscribeToken(userId: string, signature: string): boolean {
  const key = secret()
  if (!key || !userId || !signature) return false
  const expected = Buffer.from(sign(userId, key))
  const actual = Buffer.from(signature)
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}
