/**
 * Human-readable labels for raw tool identifiers in the flow picker
 * (e.g. `slack_post_message` → "Post message" under the Slack connector).
 * Pure and deterministic: split snake/kebab/camelCase into words, drop a
 * leading segment that just repeats the connector the tool is listed under,
 * sentence-case the rest. Display only — the raw name stays the stored
 * toolName on the graph node.
 */

function normalizeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function humanizeToolName(name: string, connectorKey?: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-\s]+/)
    .filter(Boolean)
  if (!words.length) return name
  // Drop leading words that spell out the connector key (which may itself be
  // multi-segment, e.g. google_drive) — but never strip the name to nothing.
  const key = connectorKey ? normalizeSegment(connectorKey) : ''
  if (key) {
    let joined = ''
    for (let count = 1; count < words.length; count++) {
      joined += normalizeSegment(words[count - 1])
      if (joined === key) {
        words.splice(0, count)
        break
      }
      if (joined.length >= key.length) break
    }
  }
  const sentence = words.map((word) => word.toLowerCase()).join(' ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}
