/** Salesforce metric source: SOQL SUM(Amount) aggregates via the Nango proxy. */
import { prisma } from '@/lib/prisma'
import { getNangoClient } from '@/lib/nango/client'
import type { NangoProxy } from '@/lib/nango/delivery'
import type { MetricDescriptor, MetricReading, MetricSource, MetricSourceContext } from '../types'
import { refId } from '../types'

const CALL_TIMEOUT_MS = 30_000
const API_VERSION = 'v58.0'

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
      `Salesforce ${args.endpoint}`,
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

/** SOQL date literal (YYYY-MM-DD) from config.periodStartIso. */
function periodStartDate(config: Record<string, unknown>): string {
  const iso =
    typeof config.periodStartIso === 'string'
      ? config.periodStartIso
      : `${new Date().getUTCFullYear()}-01-01T00:00:00Z`
  return iso.slice(0, 10)
}

const METRICS: MetricDescriptor[] = [
  { key: 'salesforce.pipeline_value', label: 'Open pipeline value', unit: 'usd' },
  { key: 'salesforce.closed_won', label: 'Closed-won revenue (period)', unit: 'usd' },
]

export function makeSalesforceMetricSource(
  proxyOverride?: NangoProxy,
  resolveOverride?: ResolveConnection,
): MetricSource {
  return {
    source: 'salesforce',
    availableMetrics: () => METRICS,
    async fetchValue(ctx, metricKey): Promise<MetricReading> {
      if (!METRICS.some((metric) => metric.key === metricKey)) {
        throw new Error(`Unknown Salesforce metric '${metricKey}'`)
      }
      const connection = await (resolveOverride ?? defaultResolve)(ctx)
      if (!connection) throw new Error('Salesforce connection not found — reconnect it in Integrations.')
      const proxy = proxyOverride ?? defaultProxy()
      const soql =
        metricKey === 'salesforce.closed_won'
          ? `SELECT SUM(Amount) total FROM Opportunity WHERE IsWon = true AND CloseDate >= ${periodStartDate(ctx.config)}`
          : 'SELECT SUM(Amount) total FROM Opportunity WHERE IsClosed = false'
      const response = await proxy({
        method: 'GET',
        endpoint: `/services/data/${API_VERSION}/query`,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        params: { q: soql },
      })
      const data = response.data as { records?: Array<{ total?: number | null }> }
      return { value: data.records?.[0]?.total ?? 0, asOf: new Date() }
    },
  }
}

export const salesforceMetricSource = makeSalesforceMetricSource()
