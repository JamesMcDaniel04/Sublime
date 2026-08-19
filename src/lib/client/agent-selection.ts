/**
 * Which agent the Agent HQ surface is showing, and how that stays in step with
 * the URL.
 *
 * `/agents` renders the roster; `/agents?agent=<id>` renders that agent's
 * workspace. Two rules earn this its own module:
 *
 *  1. The URL is the INITIAL source of truth, not something reconciled after
 *     mount. Starting the selection at null and adopting the param in an effect
 *     paints the roster for a frame before swapping to the workspace — a
 *     visible flash on every load of an agent link.
 *  2. A param can only be judged once the roster has loaded. Rewriting the URL
 *     before then throws the user out of the agent they deep-linked to.
 *
 * Pure so both rules are testable without a router.
 */

/** Sentinel selection meaning "setting up a brand-new agent". */
export const NEW_AGENT = 'new'

export type SelectionSync = {
  /** Set the selection to this value. Absent = leave it alone. */
  select?: string | null
  /** Rewrite the URL. Absent = leave it alone. */
  url?: { mode: 'push' | 'replace'; agentId: string | null }
}

/**
 * The selection to start the first render with, straight from the URL — so the
 * right surface paints immediately instead of after an effect.
 */
export function initialAgentSelection(param: string | null): string | null {
  return param || null
}

export function syncAgentSelection(input: {
  /** `?agent=` in the current URL. */
  param: string | null
  /** The component's current selection. */
  selected: string | null
  /** Agent ids the viewer can see; meaningful only once `rosterReady`. */
  knownAgentIds: readonly string[]
  /** Whether the agent list has loaded, i.e. whether an id can be judged. */
  rosterReady: boolean
  /**
   * Whether the URL moved since the last reconciliation.
   *
   * This is the piece the two effects this replaced could not express. The
   * same pair of values means opposite things depending on which side moved:
   * `{param: 'a', selected: null}` is "a link arrived, adopt it" when the URL
   * changed, and "the user left that agent, clear the URL" when it did not.
   */
  paramChanged: boolean
}): SelectionSync {
  const { param, selected, knownAgentIds, rosterReady, paramChanged } = input

  if (param === selected) {
    // Settled — except for an agent that has since been deleted (possibly in
    // another tab), which would otherwise strand this one in an empty
    // workspace it cannot navigate out of.
    if (selected && selected !== NEW_AGENT && rosterReady && !knownAgentIds.includes(selected)) {
      return { select: null }
    }
    return {}
  }

  if (paramChanged) {
    // The URL drove this: a sidebar link, the command palette, or Back.
    if (param === null) return { select: null }
    if (param === NEW_AGENT) return { select: NEW_AGENT }
    // Not judgeable yet. Doing nothing is what keeps a deep link alive across
    // the moment before the roster arrives.
    if (!rosterReady) return {}
    if (knownAgentIds.includes(param)) return { select: param }
    // Names nothing the viewer can see — fall back to the roster.
    return { url: { mode: 'replace', agentId: null } }
  }

  // The selection drove this (a click, a create, a delete): the URL follows.
  // Entering an agent from the roster is the one transition Back should undo,
  // so it pushes; everything else replaces rather than stacking history.
  return { url: { mode: param === null && selected !== null ? 'push' : 'replace', agentId: selected } }
}
