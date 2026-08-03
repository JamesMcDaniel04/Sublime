import { escapeHtml, wrapEmailHtml } from '@/lib/email/layout'

const url = (appUrl: string | null, path: string) => appUrl ? `${appUrl.replace(/\/$/, '')}${path}` : null
const cta = (appUrl: string | null, path: string, label: string) => {
  const target = url(appUrl, path)
  return target ? { label, url: target } : undefined
}

export function welcomeEmail(input: { name: string | null; appUrl: string | null }) {
  const first = input.name?.trim().split(/\s+/)[0]
  return {
    subject: 'Welcome to Sublime',
    html: wrapEmailHtml({
      heading: first ? `Welcome, ${first}` : 'Welcome to Sublime',
      bodyHtml: '<p>Sublime keeps your goals moving with agents that do real work. Set one goal and let the platform plan the work toward it.</p><p>Reply any time — a human reads every message.</p>',
      cta: cta(input.appUrl, '/goals/new', 'Set your first goal'),
    }),
  }
}

export function dripDay2Email(input: { appUrl: string | null; unsubscribeUrl: string | null }) {
  return { subject: 'Set your first goal in Sublime', html: wrapEmailHtml({ heading: 'Start with one outcome', bodyHtml: '<p>A clear goal gives your agents a destination and lets Sublime propose the work that moves it.</p>', cta: cta(input.appUrl, '/goals/new', 'Set your first goal'), unsubscribeUrl: input.unsubscribeUrl }) }
}
export function dripDay5Email(input: { appUrl: string | null; unsubscribeUrl: string | null }) {
  return { subject: 'Connect a tool and let agents work', html: wrapEmailHtml({ heading: 'Bring your work into Sublime', bodyHtml: '<p>Connect the tool where your team already works. Agents can then act on live context instead of copied notes.</p>', cta: cta(input.appUrl, '/integrations', 'Connect a tool'), unsubscribeUrl: input.unsubscribeUrl }) }
}
export function trialEndingEmail(input: { daysLeft: 3 | 1; trialEndsAt: Date; appUrl: string | null }) {
  const when = input.trialEndsAt.toISOString().slice(0, 10)
  return {
    subject: input.daysLeft === 1 ? 'Your Sublime trial ends tomorrow' : `Your Sublime trial ends in ${input.daysLeft} days`,
    html: wrapEmailHtml({ heading: `Your trial ends in ${input.daysLeft} ${input.daysLeft === 1 ? 'day' : 'days'}`, bodyHtml: `<p>Your free trial ends on ${escapeHtml(when)}. After that your card on file is charged and everything keeps running. You can change your plan or payment details in billing settings.</p>`, cta: cta(input.appUrl, '/settings?tab=billing', 'Review billing') }),
  }
}
export function dunningEmail(input: { appUrl: string | null }) {
  return { subject: 'Action needed: your Sublime payment failed', html: wrapEmailHtml({ heading: 'Your payment did not go through', bodyHtml: '<p>We will retry automatically. To avoid interruption to your agents and flows, please update your payment method.</p>', cta: cta(input.appUrl, '/settings?tab=billing', 'Fix payment method') }) }
}
export function winbackInactiveEmail(input: { appUrl: string | null; unsubscribeUrl: string | null }) {
  return { subject: 'Anything we can help with?', html: wrapEmailHtml({ heading: 'Your workspace is ready when you are', bodyHtml: '<p>If something got in the way, reply and tell us. Otherwise, open Sublime and pick up from your latest goal.</p>', cta: cta(input.appUrl, '/dashboard', 'Return to Sublime'), unsubscribeUrl: input.unsubscribeUrl }) }
}
export function winbackCancelledEmail(input: { appUrl: string | null; unsubscribeUrl: string | null }) {
  return { subject: "We'd love to have you back", html: wrapEmailHtml({ heading: 'Come back whenever the timing is right', bodyHtml: '<p>Your work can keep moving again with a new subscription. Reply if you want help deciding whether Sublime still fits.</p>', cta: cta(input.appUrl, '/settings?tab=billing', 'See plans'), unsubscribeUrl: input.unsubscribeUrl }) }
}
