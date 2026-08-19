/**
 * Shared LLM extraction for assisted metric sources (Slack / Gmail).
 *
 * Contract: NEVER fabricate. The model must return found=false when no
 * explicit value exists in the corpus, and found=false or low confidence
 * both throw — the sync fails visibly (GoalMetric.lastError) instead of
 * charting an invented number. Runs on the cheap summary model.
 */
import { DEFAULT_SUMMARY_MODEL, generateStructured } from '@/lib/llm/model-runner'
import { meterTokens } from '@/lib/usage/meter'
import { parseSheetNumber } from './sources/google-sheets'

const MAX_CORPUS_CHARS = 12_000

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    value: { type: 'number' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'string', description: 'verbatim fragment the value came from' },
  },
  required: ['found', 'value', 'confidence', 'evidence'],
  additionalProperties: false,
} as const

const SYSTEM = [
  'You extract ONE metric reading from workplace messages.',
  'Rules:',
  '- Report only a value stated explicitly in the text. Never compute, extrapolate, or guess.',
  '- When several readings exist, use the most recent one.',
  '- If no explicit value for the requested metric exists, return found=false with value=0.',
  '- confidence: high = the metric is named and the value is unambiguous; medium = value is clearly the metric but phrasing is loose; low = anything weaker.',
  '- evidence: quote the exact fragment (≤200 chars) the value came from.',
].join('\n')

export type AssistedReading = { value: number; evidence: string }

export async function extractMetricReading(params: {
  goalName: string
  metricHint?: string
  sourceLabel: string
  corpus: string
  // Meters the extraction against the workspace token budget when provided —
  // both the preview route and the sync path pass it.
  organizationId?: string
  generate?: typeof generateStructured
}): Promise<AssistedReading> {
  const corpus = params.corpus.slice(0, MAX_CORPUS_CHARS)
  if (!corpus.trim()) {
    throw new Error(`No recent content in ${params.sourceLabel} to read this sync.`)
  }
  const generate = params.generate ?? generateStructured
  const raw = await generate({
    schemaName: 'assisted_metric_reading',
    schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
    system: SYSTEM,
    user: JSON.stringify({
      metric: params.metricHint || params.goalName,
      corpus,
    }),
    maxTokens: 400,
    model: DEFAULT_SUMMARY_MODEL,
  })

  // Rough metering (~chars/4) since generateStructured returns no token usage.
  if (params.organizationId) {
    void meterTokens({ organizationId: params.organizationId, tokens: Math.ceil((SYSTEM.length + corpus.length + (raw?.length ?? 0)) / 4), path: 'lib/metrics/assisted-extraction', estimated: true })
  }

  let parsed: { found?: unknown; value?: unknown; confidence?: unknown; evidence?: unknown }
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Could not read a value from ${params.sourceLabel} this sync.`)
  }
  const value = parseSheetNumber([[parsed.value]])
  if (parsed.found !== true || value === null || parsed.confidence === 'low') {
    throw new Error(
      `No confident reading found in ${params.sourceLabel} this sync — the last value stands.`,
    )
  }
  return { value, evidence: typeof parsed.evidence === 'string' ? parsed.evidence : '' }
}
