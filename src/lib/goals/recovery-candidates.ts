/**
 * Deterministic candidate assembly for recovery-plan generation. Pure: the
 * LLM may only SELECT from what this module returns — it never invents a
 * tool or template. Ranking mirrors emit-recommendation (adoption order).
 */
import type { SeedTemplate } from '@/lib/templates/catalogue'
import { goalTemplatesFor } from '@/lib/templates/goal-fit'
import { sortByAdoption, type AdoptionStat } from '@/lib/templates/adoption'
import {
  sourceIsAvailable,
  type MetricSourceOption,
} from '@/lib/metrics/source-options'

export const RECOVERY_SOURCE_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  google_sheets: 'Google Sheets',
  postgres: 'Postgres',
  url: 'URL',
  slack_assisted: 'Slack (AI-read)',
  gmail_assisted: 'Gmail (AI-read)',
}

const MAX_AGENT_TEMPLATES = 6
const MAX_SOURCE_GAPS = 4

export type RecoveryCandidates = {
  agentTemplates: Array<{
    seedKey: string
    name: string
    description: string
    requiredIntegrations: string[]
  }>
  sourceGaps: Array<{
    source: string
    label: string
    reason: 'goal_template_source' | 'agent_requirement'
  }>
}

export function assembleRecoveryCandidates(input: {
  goalKind: string
  seeds: SeedTemplate[]
  adoptionScores: Record<string, AdoptionStat>
  sources: MetricSourceOption[]
  goalTemplateSources: string[]
}): RecoveryCandidates {
  const ranked = sortByAdoption(
    goalTemplatesFor(input.goalKind, input.seeds),
    (seed) => `seed:${seed.seedKey}`,
    input.adoptionScores,
  ).slice(0, MAX_AGENT_TEMPLATES)

  const optionBySource = new Map(input.sources.map((option) => [option.source, option]))
  // A gap is a KNOWN source option that is not currently usable. An unknown
  // name (e.g. an agent integration with no metric adapter) is never a gap —
  // recommending a connection we can't track against would be noise.
  const unavailable = (source: string): boolean => {
    if (source === 'manual') return false
    const option = optionBySource.get(source)
    return option ? !sourceIsAvailable(option) : false
  }

  const gaps: RecoveryCandidates['sourceGaps'] = []
  const seen = new Set<string>()
  const push = (
    source: string,
    reason: RecoveryCandidates['sourceGaps'][number]['reason'],
  ) => {
    if (seen.has(source) || !unavailable(source)) return
    seen.add(source)
    gaps.push({ source, label: RECOVERY_SOURCE_LABELS[source] ?? source, reason })
  }
  for (const source of input.goalTemplateSources) push(source, 'goal_template_source')
  for (const template of ranked) {
    for (const integration of template.requiredIntegrations) {
      push(integration, 'agent_requirement')
    }
  }

  return {
    agentTemplates: ranked.map((seed) => ({
      seedKey: seed.seedKey,
      name: seed.name,
      description: seed.description,
      requiredIntegrations: seed.requiredIntegrations,
    })),
    sourceGaps: gaps.slice(0, MAX_SOURCE_GAPS),
  }
}
