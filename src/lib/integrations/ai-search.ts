export type IntegrationSearchItem = { id: string; name: string; description: string }
export type IntegrationMatch = { id: string; reason: string }

const MAX_MATCHES = 6

export function parseIntegrationMatches(raw: string): IntegrationMatch[] {
  const fenced = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  try {
    const value = JSON.parse(fenced ? fenced[1].trim() : raw)
    if (!Array.isArray(value?.matches)) return []
    return value.matches.filter(
      (entry: unknown): entry is IntegrationMatch =>
        Boolean(entry && typeof entry === 'object' && typeof (entry as IntegrationMatch).id === 'string' && typeof (entry as IntegrationMatch).reason === 'string'),
    )
  } catch {
    return []
  }
}

export function sanitizeIntegrationMatches(matches: IntegrationMatch[], items: IntegrationSearchItem[]): IntegrationMatch[] {
  const ids = new Set(items.map((item) => item.id))
  const seen = new Set<string>()
  return matches.filter((match) => {
    if (!ids.has(match.id) || seen.has(match.id)) return false
    seen.add(match.id)
    return true
  }).slice(0, MAX_MATCHES)
}
