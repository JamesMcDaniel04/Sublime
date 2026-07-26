import { z } from 'zod'

export const WIDGET_TYPES = [
  'kpi',
  'trend',
  'progress',
  'comparison',
  'ratio',
  'narrative',
  'impact',
  'benchmark',
  'periods',
  'contributions',
  'history',
  'rollups',
] as const
export type WidgetType = (typeof WIDGET_TYPES)[number]

export const WIDGET_LABELS: Record<WidgetType, string> = {
  kpi: 'KPI tile',
  trend: 'Trend and pace',
  progress: 'Progress bar',
  comparison: 'Series comparison',
  ratio: 'Conversion / ratio',
  narrative: 'Copilot rationale',
  impact: 'Impact on this goal',
  benchmark: 'How teams like yours do',
  periods: 'Period history',
  contributions: 'Linked automations',
  history: 'Metric history',
  rollups: 'Supporting personal goals',
}

export type DashboardWidget = {
  id: string
  type: WidgetType
  config: Record<string, unknown>
}
export type DashboardLayout = { version: 1; widgets: DashboardWidget[] }

const metricId = z.string().min(1)
const persistedSchemas: Record<WidgetType, z.ZodType> = {
  kpi: z.object({ metricId: metricId.optional() }).strict(),
  trend: z.object({ metricId: metricId.optional() }).strict(),
  progress: z.object({}).strict(),
  comparison: z.object({ metricIds: z.array(metricId).min(2).max(4) }).strict(),
  ratio: z
    .object({
      numeratorId: metricId,
      denominatorId: metricId,
      format: z.enum(['percent', 'ratio']),
    })
    .strict(),
  narrative: z.object({ text: z.string().min(1).max(2000) }).strict(),
  impact: z.object({}).strict(),
  benchmark: z.object({}).strict(),
  periods: z.object({}).strict(),
  contributions: z.object({}).strict(),
  history: z.object({ metricId: metricId.optional() }).strict(),
  rollups: z.object({}).strict(),
}

const draftSchemas = (metricCount: number): Record<WidgetType, z.ZodType> => {
  const index = z.number().int().min(0).max(Math.max(0, metricCount - 1))
  return {
    kpi: z.object({ metric: index.optional() }).strict(),
    trend: z.object({ metric: index.optional() }).strict(),
    progress: z.object({}).strict(),
    comparison: z.object({ metrics: z.array(index).min(2).max(4) }).strict(),
    ratio: z
      .object({
        numerator: index,
        denominator: index,
        format: z.enum(['percent', 'ratio']),
      })
      .strict(),
    narrative: z.object({ text: z.string().min(1).max(2000) }).strict(),
    impact: z.object({}).strict(),
    benchmark: z.object({}).strict(),
    periods: z.object({}).strict(),
    contributions: z.object({}).strict(),
    history: z.object({ metric: index.optional() }).strict(),
    rollups: z.object({}).strict(),
  }
}

const envelopeSchema = z.object({
  version: z.literal(1),
  widgets: z.array(z.unknown()).max(16),
})
const widgetShellSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.string(),
  config: z.record(z.string(), z.unknown()).default({}),
})

function parseWith(
  value: unknown,
  schemas: Record<WidgetType, z.ZodType>,
): DashboardLayout | null {
  const envelope = envelopeSchema.safeParse(value)
  if (!envelope.success) return null
  const widgets: DashboardWidget[] = []
  const seen = new Set<string>()
  for (const raw of envelope.data.widgets) {
    const shell = widgetShellSchema.safeParse(raw)
    if (!shell.success || seen.has(shell.data.id)) continue
    if (!(WIDGET_TYPES as readonly string[]).includes(shell.data.type)) continue
    const type = shell.data.type as WidgetType
    const config = schemas[type].safeParse(shell.data.config)
    if (!config.success) continue
    seen.add(shell.data.id)
    widgets.push({
      id: shell.data.id,
      type,
      config: config.data as Record<string, unknown>,
    })
  }
  return widgets.length > 0 ? { version: 1, widgets } : null
}

export function parseDashboardLayout(value: unknown): DashboardLayout | null {
  return parseWith(value, persistedSchemas)
}

export function parseDraftLayout(
  value: unknown,
  metricCount: number,
): DashboardLayout | null {
  if (metricCount < 1) return null
  return parseWith(value, draftSchemas(metricCount))
}

export function resolveLayoutMetricRefs(
  layout: DashboardLayout,
  metricIds: string[],
): DashboardLayout {
  const id = (index: unknown) => metricIds[index as number]
  return {
    version: 1,
    widgets: layout.widgets.map((widget) => {
      const { config } = widget
      if (widget.type === 'kpi' || widget.type === 'trend' || widget.type === 'history') {
        return {
          ...widget,
          config: config.metric === undefined ? {} : { metricId: id(config.metric) },
        }
      }
      if (widget.type === 'comparison') {
        return {
          ...widget,
          config: { metricIds: (config.metrics as number[]).map((index) => metricIds[index]) },
        }
      }
      if (widget.type === 'ratio') {
        return {
          ...widget,
          config: {
            numeratorId: id(config.numerator),
            denominatorId: id(config.denominator),
            format: config.format,
          },
        }
      }
      return widget
    }),
  }
}

export function defaultLayoutForGoal(): DashboardLayout {
  const order: WidgetType[] = [
    'periods',
    'trend',
    'impact',
    'contributions',
    'benchmark',
    'history',
    'rollups',
  ]
  return {
    version: 1,
    widgets: order.map((type) => ({ id: `default-${type}`, type, config: {} })),
  }
}
