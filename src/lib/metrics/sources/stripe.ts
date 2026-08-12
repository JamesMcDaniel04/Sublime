/**
 * Stripe metric source. Auth: an org-vault Credential (type 'bearer' or
 * 'apiKeyHeader') holding a restricted Stripe secret key with read access to
 * Subscriptions — connectionRef 'credential:<id>'. MRR is computed from
 * active subscriptions (Stripe exposes no MRR endpoint); ARR = MRR × 12.
 */
import { prisma } from '@/lib/prisma'
import { credentialScope } from '@/lib/credentials/resolve'
import { decryptCredentialConfig } from '@/lib/credentials/config'
import type { MetricDescriptor, MetricReading, MetricSource, MetricSourceContext } from '../types'
import { refId } from '../types'

const PAGE_SIZE = 100
const MAX_PAGES = 10
const CALL_TIMEOUT_MS = 30_000

export type StripeSubscription = {
  items: {
    data: Array<{
      quantity?: number
      price: {
        unit_amount: number | null
        recurring: { interval: string; interval_count: number } | null
      }
    }>
  }
}

/** Months per interval unit, on a 365.25-day year. */
const MONTHS: Record<string, number> = { month: 1, year: 12, week: 84 / 365.25, day: 12 / 365.25 }

/** Pure: MRR in cents from active subscriptions. Metered prices (null
 * unit_amount) and unknown intervals are skipped, never NaN. */
export function computeMrrCents(subscriptions: StripeSubscription[]): number {
  let cents = 0
  for (const subscription of subscriptions) {
    for (const item of subscription.items.data) {
      const { price } = item
      if (price.unit_amount === null || !price.recurring) continue
      const months = MONTHS[price.recurring.interval]
      if (!months) continue
      cents += (price.unit_amount * (item.quantity ?? 1)) / (months * price.recurring.interval_count)
    }
  }
  return cents
}

const METRICS: MetricDescriptor[] = [
  { key: 'stripe.mrr', label: 'MRR (active subscriptions)', unit: 'usd' },
  { key: 'stripe.arr', label: 'ARR (MRR × 12)', unit: 'usd' },
  { key: 'stripe.active_subscriptions', label: 'Active subscriptions', unit: 'count' },
]

async function stripeKey(ctx: MetricSourceContext): Promise<string> {
  const id = refId(ctx.connectionRef, 'credential')
  const cred = await prisma.credential.findFirst({
    where: { id, ...credentialScope(ctx.organizationId) },
  })
  if (!cred) throw new Error('Stripe credential is unavailable — check Settings → Credentials.')
  const dec = decryptCredentialConfig(cred.type, cred.authConfig)
  const key = ('token' in dec ? dec.token : undefined) ?? ('key' in dec ? dec.key : undefined)
  if (!key) throw new Error('Stripe credential holds no secret key.')
  return key
}

export function makeStripeMetricSource(fetchImpl: typeof fetch = fetch): MetricSource {
  async function listActiveSubscriptions(key: string): Promise<StripeSubscription[]> {
    const all: StripeSubscription[] = []
    let startingAfter: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL('https://api.stripe.com/v1/subscriptions')
      url.searchParams.set('status', 'active')
      url.searchParams.set('limit', String(PAGE_SIZE))
      if (startingAfter) url.searchParams.set('starting_after', startingAfter)
      const response = await fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`Stripe API ${response.status}: ${(await response.text()).slice(0, 200)}`)
      const body = (await response.json()) as {
        data: Array<StripeSubscription & { id: string }>
        has_more: boolean
      }
      all.push(...body.data)
      if (!body.has_more || body.data.length === 0) break
      startingAfter = body.data[body.data.length - 1].id
    }
    return all
  }

  return {
    source: 'stripe',
    availableMetrics(goalKind) {
      // Quota is tracked in a CRM, never in Stripe. Every other kind can read
      // a Stripe number. (The pre-reduction branches were already equivalent
      // apart from quota — spec 2026-07-28.)
      return goalKind === 'quota' ? [] : METRICS
    },
    async fetchValue(ctx, metricKey): Promise<MetricReading> {
      const key = await stripeKey(ctx)
      const subscriptions = await listActiveSubscriptions(key)
      const asOf = new Date()
      if (metricKey === 'stripe.active_subscriptions') return { value: subscriptions.length, asOf }
      const mrr = computeMrrCents(subscriptions) / 100
      if (metricKey === 'stripe.mrr') return { value: mrr, asOf }
      if (metricKey === 'stripe.arr') return { value: mrr * 12, asOf }
      throw new Error(`Unknown Stripe metric '${metricKey}'`)
    },
  }
}

export const stripeMetricSource = makeStripeMetricSource()
