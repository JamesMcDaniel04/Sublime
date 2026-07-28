/**
 * Goal Copilot: one structured model call turns a natural-language goal into
 * a dashboard draft. Every field is validated against the product's closed
 * vocabularies before it leaves the server; this module performs no writes.
 */
import { z } from 'zod'
import { DEFAULT_AGENT_MODEL, generateStructured } from '@/lib/llm/model-runner'
import { GOAL_KIND_LABELS, GOAL_KIND_UNITS, type GoalSummary } from '@/lib/types'
import { GOAL_KIND_VALUES } from '@/lib/goals/kind-migration'
import { GOAL_TEMPLATES } from './goal-templates'
import { WIDGET_TYPES, parseDraftLayout, type DashboardLayout } from './dashboard'
import {
  sourceIsAvailable,
  type MetricSourceOption,
} from '@/lib/metrics/available-sources'

export class CopilotDraftError extends Error {}

const GOAL_KINDS = GOAL_KIND_VALUES
const MAX_DESCRIPTION_CHARS = 2000

/**
 * Nullable the way structured outputs actually accept it. A bare
 * `type: ['string','null']` union is outside the supported JSON Schema
 * subset and gets the whole request rejected with a 400; `anyOf` is
 * supported. See the schema conformance test in __tests__/copilot-schema.
 */
const nullable = (schema: Record<string, unknown>) =>
  ({ anyOf: [schema, { type: 'null' }] }) as const

/**
 * Free-form config travels as a JSON *string*, not an object. Strict mode
 * cannot express an open object at all — every object must close
 * additionalProperties, and closing a property-less one collapses it to `{}`,
 * which would silently drop every widget's config. The Flows copilot solves
 * the same problem the same way (see lib/flows/copilot-generate). The server
 * parses these back with parseConfigJson.
 */
const CONFIG_JSON = {
  type: 'string',
  description:
    'A JSON object serialized as a string. Example: {"metric":0}. Use {} when there is nothing to configure.',
} as const

export const COPILOT_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: nullable({ type: 'string' }),
    kind: { type: 'string', enum: [...GOAL_KINDS] },
    direction: { type: 'string', enum: ['increase', 'decrease'] },
    unit: { type: 'string', enum: ['usd', 'count', 'percent'] },
    recurrence: nullable({
      type: 'string',
      enum: ['monthly', 'quarterly', 'yearly'],
    }),
    personal: { type: 'boolean' },
    suggestedTarget: nullable({
      type: 'object',
      properties: {
        value: { type: 'number' },
        rationale: { type: 'string' },
      },
      required: ['value', 'rationale'],
      additionalProperties: false,
    }),
    suggestedTargetDate: nullable({
      type: 'string',
      description: 'YYYY-MM-DD, must be in the future',
    }),
    // Item counts are enforced by rawDraftSchema below and restated in the
    // system prompt — minItems/maxItems are not part of the supported subset.
    metrics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          role: { type: 'string', enum: ['primary', 'supporting'] },
          source: { type: 'string' },
          metricKey: { type: 'string' },
          unit: { type: 'string', enum: ['usd', 'count', 'percent'] },
          config: CONFIG_JSON,
        },
        required: ['label', 'role', 'source', 'metricKey', 'unit', 'config'],
        additionalProperties: false,
      },
    },
    widgets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: [...WIDGET_TYPES] },
          config: CONFIG_JSON,
        },
        required: ['id', 'type', 'config'],
        additionalProperties: false,
      },
    },
    rationale: { type: 'string' },
  },
  required: [
    'name',
    'description',
    'kind',
    'direction',
    'unit',
    'recurrence',
    'personal',
    'suggestedTarget',
    'suggestedTargetDate',
    'metrics',
    'widgets',
    'rationale',
  ],
  additionalProperties: false,
} as const

const SYSTEM = [
  'You design a goal-tracking dashboard from a user description.',
  'Rules:',
  `- kind MUST be one of: ${GOAL_KINDS.join(', ')}. "arr" is any recurring or closed revenue number, "quota" is sales attainment against a committed number, "kpi" is everything else — funnels, rates, counts and cost. Blends use the dominant kind plus supporting metrics.`,
  '- direction is yours to choose and is NOT implied by the kind: use "decrease" whenever a falling number is the win (cost, spend, churn, cycle time, defects) and "increase" otherwise. Do not default to increase for a cost-reduction goal.',
  '- Use ONLY the metric sources listed as available in the input. When nothing fits, use source "manual" with metricKey "manual.value".',
  '- Use 1-4 metrics and exactly one role "primary"; it drives progress and risk. More than 4 metrics is rejected.',
  '- Every config field is a JSON object SERIALIZED AS A STRING, not an object. Send "{}" when empty.',
  `- Widget config references metrics by array INDEX, as a JSON string: kpi/trend/history {"metric":0}, comparison {"metrics":[0,1]}, ratio {"numerator":0,"denominator":1,"format":"percent"} (or "ratio"), narrative {"text":"..."}, and progress/impact/benchmark/periods/contributions/rollups {}.`,
  '- Use at most 12 widgets.',
  '- Put kpi first, then trend; add useful ratio/comparison widgets; include narrative, impact, and history.',
  '- suggestedTarget is an honest starting point, never fabricated precision. Use null when the description gives no basis.',
  '- suggestedTargetDate is a sensible future YYYY-MM-DD, or null when unclear.',
  '- Respond with the JSON object only.',
].join('\n')

function fewShotTemplates(): Array<{
  name: string
  kind: string
  recurrence: string | null
}> {
  return GOAL_TEMPLATES.slice(0, 8).map((template) => ({
    name: template.name,
    kind: template.kind,
    recurrence: template.recurrence,
  }))
}

/**
 * Accept config in either shape: the JSON string the schema now asks for, or
 * a bare object (what the model sometimes emits anyway, and what the older
 * fixtures use). Anything unparseable degrades to `{}` rather than failing the
 * whole draft — a malformed widget config costs one widget, not the dashboard.
 */
export function parseConfigJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string' || value.trim() === '') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const configJson = z.unknown().transform(parseConfigJson)

/** Widgets stay `unknown` until parseDraftLayout validates them, so their
 *  config string is decoded here rather than in the zod shell. */
function withParsedWidgetConfig(widget: unknown): unknown {
  if (!widget || typeof widget !== 'object' || Array.isArray(widget)) return widget
  const shell = widget as Record<string, unknown>
  return { ...shell, config: parseConfigJson(shell.config) }
}

const rawDraftSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  kind: z.string(),
  direction: z.enum(['increase', 'decrease']),
  unit: z.enum(['usd', 'count', 'percent']),
  recurrence: z.enum(['monthly', 'quarterly', 'yearly']).nullable(),
  personal: z.boolean(),
  suggestedTarget: z
    .object({ value: z.number().finite(), rationale: z.string().max(500) })
    .nullable(),
  suggestedTargetDate: z.string().nullable(),
  metrics: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        role: z.enum(['primary', 'supporting']),
        source: z.string(),
        metricKey: z.string(),
        unit: z.enum(['usd', 'count', 'percent']),
        config: configJson,
      }),
    )
    .min(1)
    .max(4),
  widgets: z.array(z.unknown()).max(12),
  rationale: z.string().max(1000),
})

export type CopilotDraftMetric = {
  label: string
  role: 'primary' | 'supporting'
  source: string
  metricKey: string
  unit: 'usd' | 'count' | 'percent'
  connectionRef: string | null
  config: Record<string, unknown>
}
export type CopilotDraft = {
  name: string
  description: string | null
  kind: GoalSummary['kind']
  direction: 'increase' | 'decrease'
  unit: 'usd' | 'count' | 'percent'
  recurrence: 'monthly' | 'quarterly' | 'yearly' | null
  personal: boolean
  suggestedTarget: { value: number; rationale: string } | null
  suggestedTargetDate: string | null
  metrics: CopilotDraftMetric[]
  layout: DashboardLayout | null
  rationale: string
}

const SOURCE_FALLBACK_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  google_sheets: 'Google Sheets',
  postgres: 'Postgres',
  url: 'URL',
  slack_assisted: 'Slack (AI-read)',
  gmail_assisted: 'Gmail (AI-read)',
}

export function validateCopilotDraft(
  raw: string,
  sources: MetricSourceOption[],
  now: Date = new Date(),
): { draft: CopilotDraft; notes: string[] } {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    throw new CopilotDraftError(
      'The Copilot returned an unreadable draft — try rephrasing your goal.',
    )
  }
  const shell = rawDraftSchema.safeParse(parsedJson)
  if (!shell.success) {
    throw new CopilotDraftError(
      'The Copilot returned an unusable draft — try rephrasing your goal.',
    )
  }
  const data = shell.data
  if (!(GOAL_KINDS as readonly string[]).includes(data.kind)) {
    throw new CopilotDraftError(
      'The Copilot could not map this to a supported goal kind — try rephrasing.',
    )
  }
  const kind = data.kind as GoalSummary['kind']
  const notes: string[] = []
  const availableBySource = new Map(
    sources
      .filter((option) => sourceIsAvailable(option))
      .map((option) => [option.source, option]),
  )

  const metrics: CopilotDraftMetric[] = data.metrics.map((metric) => {
    const option = availableBySource.get(metric.source)
    if (!option) {
      notes.push(
        `${SOURCE_FALLBACK_LABELS[metric.source] ?? metric.source} isn't connected — "${metric.label}" starts as a manually recorded series.`,
      )
      return {
        ...metric,
        source: 'manual',
        metricKey: 'manual.value',
        connectionRef: null,
        config: {},
      }
    }
    let metricKey = metric.metricKey
    if (
      option.metrics.length > 0 &&
      !option.metrics.some((descriptor) => descriptor.key === metricKey)
    ) {
      metricKey = option.metrics[0].key
      notes.push(
        `Adjusted "${metric.label}" to the ${metric.source} metric this workspace actually exposes.`,
      )
    }
    const connectionRef =
      option.connections.length === 1 ? option.connections[0].ref : null
    return { ...metric, metricKey, connectionRef, config: metric.config }
  })

  let sawPrimary = false
  for (const metric of metrics) {
    if (metric.role === 'primary') {
      if (sawPrimary) metric.role = 'supporting'
      sawPrimary = true
    }
  }
  if (!sawPrimary) metrics[0].role = 'primary'

  const layout = parseDraftLayout(
    { version: 1, widgets: data.widgets.map((widget) => withParsedWidgetConfig(widget)) },
    metrics.length,
  )
  if (!layout && data.widgets.length > 0) {
    notes.push(
      'The Copilot suggested widgets this dashboard cannot render — using the standard layout.',
    )
  }

  let suggestedTargetDate: string | null = null
  if (data.suggestedTargetDate) {
    const validShape = /^\d{4}-\d{2}-\d{2}$/.test(data.suggestedTargetDate)
    const date = validShape
      ? new Date(`${data.suggestedTargetDate}T23:59:59Z`)
      : new Date(Number.NaN)
    if (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === data.suggestedTargetDate &&
      date.getTime() > now.getTime()
    ) {
      suggestedTargetDate = data.suggestedTargetDate
    } else {
      notes.push('The suggested target date was not usable — pick one below.')
    }
  }

  return {
    draft: {
      name: data.name,
      description: data.description,
      kind,
      // The kind no longer implies direction — 'savings' collapsed into
      // 'kpi' (spec 2026-07-28), so the model chooses and the prompt says so.
      direction: data.direction,
      unit: GOAL_KIND_UNITS[kind] ?? data.unit,
      recurrence: data.recurrence,
      personal: data.personal,
      suggestedTarget: data.suggestedTarget,
      suggestedTargetDate,
      metrics,
      layout,
      rationale: data.rationale,
    },
    notes,
  }
}

export async function draftGoalDashboard(params: {
  description: string
  sources: MetricSourceOption[]
  generate?: typeof generateStructured
  now?: Date
}): Promise<{ draft: CopilotDraft; notes: string[] }> {
  const generate = params.generate ?? generateStructured
  const raw = await generate({
    schemaName: 'goal_copilot_draft',
    schema: COPILOT_DRAFT_SCHEMA as unknown as Record<string, unknown>,
    system: SYSTEM,
    user: JSON.stringify({
      description: params.description.slice(0, MAX_DESCRIPTION_CHARS),
      today: (params.now ?? new Date()).toISOString().slice(0, 10),
      kinds: GOAL_KINDS.map((kindName) => ({
        kind: kindName,
        label: GOAL_KIND_LABELS[kindName],
        unit: GOAL_KIND_UNITS[kindName],
      })),
      availableSources: params.sources.filter(sourceIsAvailable).map((option) => ({
        source: option.source,
        metrics: option.metrics,
      })),
      exampleGoals: fewShotTemplates(),
    }),
    maxTokens: 2000,
    model: DEFAULT_AGENT_MODEL,
  })
  return validateCopilotDraft(raw, params.sources, params.now)
}
