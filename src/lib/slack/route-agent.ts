/**
 * Addressing an AGENT from Slack.
 *
 * Sublime's Slack app is one bot user, so an agent has no Slack handle of its
 * own — you mention the app and then name the teammate inside the message.
 * This resolves that second half.
 *
 * The load-bearing rule is that addressing requires an EXPLICIT marker
 * (`@Name`, `Name:`, or `ask Name`). A bare leading name is deliberately not
 * enough: agents are named by people, so a roster containing "Update" would
 * otherwise hijack "update the board" and silently steal every message from
 * the flow triggers that already handle it. Requiring a marker means this can
 * only ever ADD routing, never redirect what already worked.
 */

export type MentionableAgent = { id: string; name: string }

/** Remove a leading `<@Uxxxx>` bot mention and surrounding whitespace. */
export function stripBotMention(text: string): string {
  return text.replace(/^\s*<@[A-Z0-9]+>\s*/i, '').trim()
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `{ agentId, text }` when the message addresses a known agent AND carries an
 * actual request; `null` otherwise, which means "fall through to normal flow
 * trigger matching".
 */
export function resolveAgentMention(
  raw: string,
  agents: MentionableAgent[],
): { agentId: string; text: string } | null {
  const body = stripBotMention(raw)
  if (!body) return null

  // Longest name first, so "Riley Scout" is never shadowed by "Riley".
  const candidates = agents
    .filter((agent) => agent.name.trim().length > 0)
    .sort((a, b) => b.name.trim().length - a.name.trim().length)

  for (const agent of candidates) {
    const name = escapeRegExp(agent.name.trim())
    // `\b` is wrong here: agent names are user-authored and may END in a
    // non-word character ("C++ (Helper)"), where \b never matches before a
    // space. Require an explicit boundary instead — whitespace, a separator,
    // or end of message.
    const after = '(?=\\s|[:,-]|$)'
    // Three admissible markers. `ask` may be combined with `@`, and a `:`/`,`
    // separator after the name is optional in every form — but `@` or `ask`
    // must be present, which is what makes a bare name fall through.
    const pattern = new RegExp(
      `^(?:ask\\s+)?@${name}${after}\\s*[:,-]?\\s*` +
        `|^ask\\s+${name}${after}\\s*(?:to\\s+)?[:,-]?\\s*` +
        `|^${name}\\s*[:,]\\s*`,
      'i',
    )
    const match = body.match(pattern)
    if (!match) continue
    const text = body.slice(match[0].length).trim()
    // Naming an agent without asking for anything is not a request.
    if (!text) return null
    return { agentId: agent.id, text }
  }

  return null
}
