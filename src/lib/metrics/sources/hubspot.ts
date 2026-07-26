/** HubSpot metric source: deal-amount aggregates via the Nango proxy.
 * pipeline_value = sum of open deals' amount; closed_won = sum of won deals
 * with closedate >= config.periodStartIso (default: Jan 1 this UTC year). */
import { prisma } from '@/lib/prisma'
import { getNangoClient } from '@/lib/nango/client'
import type { NangoProxy } from '@/lib/nango/delivery'
import type { MetricDescriptor, MetricReading, MetricSource, MetricSourceContext } from '../types'
import { refId } from '../types'

const PAGE_SIZE = 100
const MAX_PAGES = 10
const CALL_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

function defaultProxy(): NangoProxy {
  const nango = getNangoClient()
  return (args) =>
    withTimeout(
      nango.proxy(args as never) as Promise<{ data: unknown }>,
      CALL_TIMEOUT_MS,
      `HubSpot ${args.endpoint}`,
    )
}

type Connection = { connectionId: string; providerConfigKey: string }
type ResolveConnection = (ctx: MetricSourceContext) => Promise<Connection | null>

const defaultResolve: ResolveConnection = async (ctx) => {
  const connectionId = refId(ctx.connectionRef, 'nango')
  return prisma.nangoConnection.findFirst({
    where: {
      organizationId: ctx.organizationId,
      connectionId,
      OR: [{ userId: null }, ...(ctx.userId ? [{ userId: ctx.userId }] : [])],
    },
    select: { connectionId: true, providerConfigKey: true },
  })
}

function defaultPeriodStart(config: Record<string, unknown>): string {
  if (typeof config.periodStartIso === 'string') return config.periodStartIso
  return `${new Date().getUTCFullYear()}-01-01T00:00:00Z`
}

const METRICS: MetricDescriptor[] = [
  { key: 'hubspot.pipeline_value', label: 'Open pipeline value', unit: 'usd' },
  { key: 'hubspot.closed_won', label: 'Closed-won revenue (period)', unit: 'usd' },
]

export function makeHubspotMetricSource(
  proxyOverride?: NangoProxy,
  resolveOverride?: ResolveConnection,
): MetricSource {
  return {
    source: 'hubspot',
    availableMetrics: () => METRICS,
    async fetchValue(ctx, metricKey): Promise<MetricReading> {
      if (!METRICS.some((metric) => metric.key === metricKey)) {
        throw new Error(`Unknown HubSpot metric '${metricKey}'`)
      }
      const connection = await (resolveOverride ?? defaultResolve)(ctx)
      if (!connection) throw new Error('HubSpot connection not found — reconnect it in Integrations.')
      const proxy = proxyOverride ?? defaultProxy()

      const filters =
        metricKey === 'hubspot.closed_won'
          ? [
              { propertyName: 'hs_is_closed_won', operator: 'EQ', value: 'true' },
              {
                propertyName: 'closedate',
                operator: 'GTE',
                value: String(Date.parse(defaultPeriodStart(ctx.config))),
              },
            ]
          : [{ propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }]

      let total = 0
      let after: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await proxy({
          method: 'POST',
          endpoint: '/crm/v3/objects/deals/search',
          connectionId: connection.connectionId,
          providerConfigKey: connection.providerConfigKey,
          data: {
            limit: PAGE_SIZE,
            ...(after ? { after } : {}),
            properties: ['amount'],
            filterGroups: [{ filters }],
          },
        })
        const data = response.data as {
          results?: Array<{ properties?: { amount?: string | null } }>
          paging?: { next?: { after?: unknown } }
        }
        for (const deal of data.results ?? []) {
          const amount = Number(deal.properties?.amount)
          if (Number.isFinite(amount)) total += amount
        }
        after = typeof data.paging?.next?.after === 'string' ? data.paging.next.after : undefined
        if (!after) break
      }
      return { value: total, asOf: new Date() }
    },
  }
}

export const hubspotMetricSource = makeHubspotMetricSource()
