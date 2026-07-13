/**
 * Resolve a template selected on the catalogue from Next's dynamic route
 * segment. Seed ids contain a colon (`seed:<key>`), which may arrive URL-
 * encoded (and can be encoded twice after redirects). Stored templates use
 * opaque database ids and continue to match exactly.
 */
export function templateRouteIdCandidates(routeId: string): string[] {
  const candidates = new Set<string>([routeId])
  let decoded = routeId
  for (let pass = 0; pass < 2; pass++) {
    try {
      const next = decodeURIComponent(decoded)
      candidates.add(next)
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return [...candidates]
}

export function findTemplateForRoute<T extends { id: string; seedKey?: string }>(
  templates: T[],
  routeId: string,
): T | undefined {
  for (const candidate of templateRouteIdCandidates(routeId)) {
    const exact = templates.find((template) => template.id === candidate)
    if (exact) return exact

    const seedKey = candidate.startsWith('seed:') ? candidate.slice('seed:'.length) : candidate
    const seed = templates.find((template) => template.seedKey === seedKey)
    if (seed) return seed
  }
  return undefined
}
