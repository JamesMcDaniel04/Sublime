/**
 * Which agents work on a goal (spec 2026-07-27). Pure — no I/O — so ordering
 * and applicability are exhaustively unit-testable.
 *
 * Composition, in display order: the goal template's curated seeds, then the
 * goal-native seeds that apply, then a kind-matched fallback used ONLY when
 * curation is empty or absent. That last rule is what makes an explicit
 * `agents: []` meaningful: it says "nothing here fits, go find matches by kind"
 * rather than "no agents at all".
 */
import { goalTemplateByKey } from '@/lib/goals/goal-templates'
import { getSeedByKey, type SeedTemplate } from '@/lib/templates/catalogue'
import { goalTemplatesFor } from '@/lib/templates/goal-fit'
import { AGENT_WRITABLE_SOURCES } from '@/lib/goals/agent-tool-policy'
import {
  GOAL_METRIC_COLLECTOR_KEY,
  GOAL_PACE_AUDITOR_KEY,
  GOAL_PERIOD_CLOSE_KEY,
} from '@/lib/templates/goal-native-seeds'

export type BundleOrigin = 'curated' | 'goal_native' | 'kind_match'

export type BundleEntry = {
  seedKey: string
  name: string
  description: string
  requiredIntegrations: string[]
  origin: BundleOrigin
  /** True when applicability depends on a choice not yet made (the metric
   *  source, before the goal exists). The UI renders a qualifier. */
  conditional: boolean
  deployed: boolean
}

export type BundleInput = {
  templateKey?: string | null
  kind: string
  /** The goal's primary metric source. `null` = not chosen yet (pre-creation). */
  source?: string | null
  recurrence?: string | null
  deployedSeedKeys?: string[]
}

/** How many kind-matched seeds to offer when falling back. Enough to be useful,
 *  short enough that the card stays a decision rather than a catalogue. */
const MAX_FALLBACK = 3

function goalNativeKeysFor(input: BundleInput): { key: string; conditional: boolean }[] {
  const entries: { key: string; conditional: boolean }[] = [
    { key: GOAL_PACE_AUDITOR_KEY, conditional: false },
  ]

  // Mirrors canWriteDatapoint: offering the collector on a system-of-record
  // goal would produce an agent whose first log_datapoint call is refused.
  const source = input.source
  if (source === null || source === undefined) {
    entries.push({ key: GOAL_METRIC_COLLECTOR_KEY, conditional: true })
  } else if (AGENT_WRITABLE_SOURCES.has(source)) {
    entries.push({ key: GOAL_METRIC_COLLECTOR_KEY, conditional: false })
  }

  if (input.recurrence) {
    entries.push({ key: GOAL_PERIOD_CLOSE_KEY, conditional: false })
  }
  return entries
}

export function bundleForGoal(input: BundleInput): BundleEntry[] {
  const deployed = new Set(input.deployedSeedKeys ?? [])
  const seen = new Set<string>()
  const bundle: BundleEntry[] = []

  const push = (seed: SeedTemplate, origin: BundleOrigin, conditional: boolean) => {
    if (seen.has(seed.seedKey)) return
    seen.add(seed.seedKey)
    bundle.push({
      seedKey: seed.seedKey,
      name: seed.name,
      description: seed.description,
      requiredIntegrations: seed.requiredIntegrations,
      origin,
      conditional,
      deployed: deployed.has(seed.seedKey),
    })
  }

  // 1. Curated. An unknown key (a template removed since the goal was created)
  //    degrades to the fallback rather than throwing.
  const template = input.templateKey ? goalTemplateByKey(input.templateKey) : null
  for (const seedKey of template?.agents ?? []) {
    const seed = getSeedByKey(seedKey)
    if (seed) push(seed, 'curated', false)
  }

  // 2. Goal-native.
  for (const entry of goalNativeKeysFor(input)) {
    const seed = getSeedByKey(entry.key)
    if (seed) push(seed, 'goal_native', entry.conditional)
  }

  // 3. Fallback — only when curation produced nothing.
  const hasCurated = bundle.some((entry) => entry.origin === 'curated')
  if (!hasCurated) {
    for (const seed of goalTemplatesFor(input.kind).slice(0, MAX_FALLBACK)) {
      push(seed, 'kind_match', false)
    }
  }

  return bundle
}
