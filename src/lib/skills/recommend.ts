import type { SeedTemplate } from '@/lib/templates/catalogue'

type RecommendableSkill = {
  name: string
  description: string
  category: string
  audience: string[]
  tags: string[]
}

const CATEGORY_TERMS: Record<string, string[]> = {
  analysis: ['analysis', 'audit', 'review', 'forecast', 'pattern', 'score', 'risk', 'explainer'],
  communication: ['brief', 'digest', 'update', 'slack', 'packet', 'handoff', 'email'],
  data: ['data', 'metrics', 'table', 'sheet', 'warehouse', 'score', 'digest'],
  operations: ['operations', 'handoff', 'command', 'coordinator', 'onboarding', 'readiness', 'plan'],
  planning: ['plan', 'readiness', 'calendar', 'priority', 'coordinator', 'roadmap', 'onboarding'],
  reasoning: ['review', 'analysis', 'explainer', 'risk', 'pattern', 'decision'],
  reliability: ['audit', 'incident', 'risk', 'review', 'quality', 'readiness'],
  writing: ['email', 'content', 'brief', 'follow-up', 'writer', 'narrative'],
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
}

/** Deterministic, tool-independent template suggestions for a skill detail page. */
export function recommendTemplatesForSkill(
  skill: RecommendableSkill,
  templates: SeedTemplate[],
  limit = 4,
): SeedTemplate[] {
  const skillWords = words([
    skill.name,
    skill.description,
    skill.category,
    ...skill.audience,
    ...skill.tags,
    ...(CATEGORY_TERMS[skill.category.toLowerCase()] ?? []),
  ].join(' '))

  return templates
    .map((template, index) => {
      const templateWords = words([
        template.name,
        template.description,
        ...template.departments,
      ].join(' '))
      let score = 0
      for (const word of skillWords) if (templateWords.has(word)) score += word.length >= 7 ? 3 : 1
      // Stable tie-breaker keeps suggestions diverse and predictable.
      return { template, score, index }
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(({ template }) => template)
}
