import { emailConfigured } from '@/lib/integrations/email'

const RESEND_API_URL = 'https://api.resend.com/emails'
export { emailConfigured }

export function contactInbox(): string {
  return process.env.CONTACT_INBOX || 'hello@trysublime.io'
}

export async function sendRawEmail(input: { to: string; subject: string; html?: string; text?: string; replyTo?: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('Resend API key is not configured')
  const payload: Record<string, unknown> = {
    from: process.env.EMAIL_FROM || 'Sublime <onboarding@resend.dev>',
    to: [input.to],
    subject: input.subject,
  }
  if (input.html) {
    payload.html = input.html
    payload.text = input.text ?? input.html.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim()
  } else payload.text = input.text ?? ''
  if (input.replyTo) payload.reply_to = input.replyTo
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Email API error ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
}
