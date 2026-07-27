/**
 * GA4 property discovery. A numeric property id is not something anyone can
 * recite, so the goal wizard offers a named picker instead of an input.
 *
 * The parsing lives here rather than in the route handler so it unit-tests as a
 * pure function — the same split every metric adapter uses.
 */

export type Ga4Property = { propertyId: string; displayName: string }

/**
 * Flatten the Admin API's accountSummaries into a flat property list.
 *
 * Tolerant by design: a picker that renders empty is recoverable (the field
 * falls back to a manual id input), whereas one that throws would block goal
 * creation on a malformed upstream payload.
 */
export function parseAccountSummaries(data: unknown): Ga4Property[] {
  const summaries = (data as { accountSummaries?: unknown })?.accountSummaries
  if (!Array.isArray(summaries)) return []
  const properties: Ga4Property[] = []
  for (const summary of summaries) {
    const list = (summary as { propertySummaries?: unknown })?.propertySummaries
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const resource = (entry as { property?: unknown })?.property
      if (typeof resource !== 'string') continue
      // 'properties/493820104' → '493820104'
      const propertyId = resource.split('/').pop() ?? ''
      if (!propertyId) continue
      const displayName = (entry as { displayName?: unknown })?.displayName
      properties.push({
        propertyId,
        displayName: typeof displayName === 'string' && displayName ? displayName : propertyId,
      })
    }
  }
  return properties
}
