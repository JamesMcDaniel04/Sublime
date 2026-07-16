/**
 * @mention parsing for Flow Jam comments — pure, shared by the API (who to
 * notify) and the panel (highlighting + autocomplete insertion).
 *
 * A mention is '@' followed by a workspace member's display name, matched
 * case-insensitively with the LONGEST name winning ("@James Smith" mentions
 * James Smith, not James), and only at a word boundary ("@Jamesx" mentions
 * nobody). Matching against the canonical member list — never a free-text
 * guess — is what keeps false positives out of people's notifications.
 */

export type MentionCandidate = { id: string; name: string }

export type MentionSegment = { text: string; mention: boolean }

/** True when the character can't extend a name (so the match ends cleanly). */
function isBoundary(character: string | undefined): boolean {
  return !character || !/[\p{L}\p{N}]/u.test(character)
}

/** Longest member whose name starts the text (case-insensitive, boundary-checked). */
function matchAt(lowerRest: string, sorted: MentionCandidate[]): MentionCandidate | null {
  for (const member of sorted) {
    const name = member.name.toLowerCase()
    if (lowerRest.startsWith(name) && isBoundary(lowerRest[name.length])) return member
  }
  return null
}

function byNameLengthDesc(members: MentionCandidate[]): MentionCandidate[] {
  return members
    .filter((member) => member.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length)
}

/** Unique mentioned user ids, in order of first appearance. */
export function extractMentions(body: string, members: MentionCandidate[]): string[] {
  const sorted = byNameLengthDesc(members)
  if (sorted.length === 0) return []
  const lower = body.toLowerCase()
  const found: string[] = []
  let at = lower.indexOf('@')
  while (at !== -1) {
    const hit = matchAt(lower.slice(at + 1), sorted)
    if (hit && !found.includes(hit.id)) found.push(hit.id)
    at = lower.indexOf('@', at + 1)
  }
  return found
}

/** Split a body into plain/mention segments for highlighted rendering. */
export function splitMentionSegments(body: string, members: MentionCandidate[]): MentionSegment[] {
  const sorted = byNameLengthDesc(members)
  const segments: MentionSegment[] = []
  const lower = body.toLowerCase()
  let cursor = 0
  let at = lower.indexOf('@')
  while (at !== -1) {
    const hit = matchAt(lower.slice(at + 1), sorted)
    if (hit) {
      if (at > cursor) segments.push({ text: body.slice(cursor, at), mention: false })
      const end = at + 1 + hit.name.length
      segments.push({ text: body.slice(at, end), mention: true })
      cursor = end
      at = lower.indexOf('@', end)
    } else {
      at = lower.indexOf('@', at + 1)
    }
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor), mention: false })
  return segments
}
