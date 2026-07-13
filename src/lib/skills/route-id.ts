/**
 * Next may expose an encoded dynamic segment to a client component. Older
 * catalogue links also encoded the id before routing, so tolerate both a
 * normal segment and a once/double-encoded segment at this boundary.
 */
export function decodeSkillRouteId(value: string): string {
  let decoded = value
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return decoded
}
