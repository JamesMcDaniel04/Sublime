/**
 * Relevance tiering for the template catalogue: partitions templates into
 * "ready" (all required integrations already connected) vs "connect" (some
 * missing), and provides a stable, non-destructive sort by that tiering.
 * Product rule: sort + Connect CTA, never hide. Pure — no I/O.
 */
import { canonicalIntegrationSlug } from './departments'

export type Tier = 'ready' | 'connect'

/** Canonical required slugs that are not present in the connected set. */
export function missingIntegrations(required: string[], connected: Iterable<string>): string[] {
  const have = new Set([...connected].map(canonicalIntegrationSlug))
  return required.map(canonicalIntegrationSlug).filter((slug) => !have.has(slug))
}

/** 'ready' when every required integration is connected (or none required); else 'connect'. */
export function tierForTemplate(required: string[], connected: Iterable<string>): Tier {
  return missingIntegrations(required, connected).length === 0 ? 'ready' : 'connect'
}

/** Available-tools chips (GET /api/integrations/available) → canonical connected slug set. */
export function connectedSlugSet(tools: { key?: string; label?: string; slug?: string; connected: boolean }[]): Set<string> {
  const set = new Set<string>()
  for (const t of tools) {
    if (!t.connected) continue
    set.add(canonicalIntegrationSlug(t.key ?? t.slug ?? t.label ?? ''))
  }
  return set
}

/** Stable sort: ready templates first, never removing any. Presentation-only. */
export function sortByReadiness<T extends { requiredIntegrations: string[] }>(items: T[], connected: Iterable<string>): T[] {
  const have = new Set([...connected].map(canonicalIntegrationSlug))
  const ready = (t: T) => t.requiredIntegrations.map(canonicalIntegrationSlug).every((s) => have.has(s))
  return [...items].sort((a, b) => Number(ready(b)) - Number(ready(a)))
}

/**
 * Persona-fit ordering: stable sort desc by the sum of the org's persona
 * department weights over an item's departments. Identity when no weights
 * exist (new org, persona not yet computed). Composes with sortByReadiness:
 * both are stable, so applying persona fit FIRST leaves readiness as the
 * primary key and persona fit as the within-group tiebreak.
 */
export function sortByPersonaFit<T extends { departments?: readonly string[] }>(
  items: T[],
  weights: Record<string, number> | null | undefined,
): T[] {
  if (!weights) return items
  const fit = (item: T) => (item.departments ?? []).reduce((sum, d) => sum + (weights[d] ?? 0), 0)
  return items
    .map((item, index) => ({ item, index, fit: fit(item) }))
    .sort((a, b) => b.fit - a.fit || a.index - b.index)
    .map((entry) => entry.item)
}
