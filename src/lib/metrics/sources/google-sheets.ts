/** Google Sheets metric source — the universal escape hatch: a named A1 range
 * is the reading. Native Google OAuth; connectionRef 'google:<id>' where id
 * is the GoogleOAuthConnection row id (what googleProxy resolves). */
import { googleProxy } from '@/lib/google/proxy'
import { sheetsGetValues, type NangoProxy } from '@/lib/nango/delivery'
import type { MetricDescriptor, MetricReading, MetricSource, MetricSourceContext } from '../types'
import { refId } from '../types'

const METRICS: MetricDescriptor[] = [
  { key: 'sheets.range', label: 'Cell value (A1 range)', unit: 'usd' },
]

/** First parseable number in the range, reading row-major. US-format only:
 * strips $, commas, spaces, and % (percent divides by 100). */
export function parseSheetNumber(values: unknown): number | null {
  if (!Array.isArray(values)) return null
  for (const row of values) {
    if (!Array.isArray(row)) continue
    for (const cell of row) {
      if (typeof cell === 'number' && Number.isFinite(cell)) return cell
      if (typeof cell !== 'string') continue
      const percent = cell.trim().endsWith('%')
      const cleaned = cell.replace(/[$,\s%]/g, '')
      if (cleaned === '') continue
      const parsed = Number(cleaned)
      if (Number.isFinite(parsed)) return percent ? parsed / 100 : parsed
    }
  }
  return null
}

export function makeGoogleSheetsMetricSource(proxyOverride?: NangoProxy): MetricSource {
  return {
    source: 'google_sheets',
    availableMetrics: () => METRICS,
    async fetchValue(ctx: MetricSourceContext, metricKey): Promise<MetricReading> {
      if (metricKey !== 'sheets.range') throw new Error(`Unknown Sheets metric '${metricKey}'`)
      const spreadsheetId =
        typeof ctx.config.spreadsheetId === 'string' ? ctx.config.spreadsheetId : ''
      const range = typeof ctx.config.range === 'string' ? ctx.config.range : ''
      if (!spreadsheetId || !range) {
        throw new Error('Sheets binding needs a spreadsheetId and an A1 range.')
      }
      const connectionId = refId(ctx.connectionRef, 'google')
      const proxy =
        proxyOverride ?? googleProxy({ organizationId: ctx.organizationId, connectionId })
      const data = await sheetsGetValues(
        {
          connectionId,
          providerConfigKey: 'google-sheets',
          provider: 'google-native',
          organizationId: ctx.organizationId,
          scope: 'org',
        },
        { spreadsheetId, range },
        proxy,
      )
      const value = parseSheetNumber((data as { values?: unknown })?.values)
      if (value === null) throw new Error(`No numeric value found in ${range}.`)
      return { value, asOf: new Date() }
    },
  }
}

export const googleSheetsMetricSource = makeGoogleSheetsMetricSource()
