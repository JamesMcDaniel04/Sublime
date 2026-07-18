import Stripe from 'stripe'

let cached: Stripe | null = null

/** Server-side Stripe client. Lazy so builds without env still compile. */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured')
  if (!cached) cached = new Stripe(key)
  return cached
}

/** Public origin for redirect URLs (checkout success/cancel, portal return). */
export function appOrigin(fallbackOrigin: string): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, '')
  return configured || fallbackOrigin
}
