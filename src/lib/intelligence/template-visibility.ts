/**
 * Pure: mine-before-community sectioning for GET /api/agent-templates. `rows`
 * must already be serialized, each carrying `mine` and `visibleToViewer` for
 * the caller's org — see serializeTemplate in the route.
 *
 * This module deliberately does NOT decide visibility any more. It used to
 * re-derive the auto-generated rule inline, which meant two places encoded who
 * may read a template — and a drifted visibility rule is a data leak, not a
 * bug. The single rule now lives in lib/templates/visibility.ts and covers
 * both auto-generated process intelligence (org-private) and the explicit
 * org/community setting a template saved from a flow carries.
 *
 * Visible rows are sectioned: the caller's own rows first, then everything
 * else (community + any extra built-ins passed in), preserving each section's
 * incoming relative order.
 *
 * Lives outside route.ts because Next.js route modules may only export route
 * handlers / config — an extra named export there fails the route's generated
 * type check.
 */
export function selectVisibleTemplates<T extends { mine: boolean; visibleToViewer: boolean }>(rows: T[], extraCommunity: T[] = []): T[] {
  const visible = rows.filter((t) => t.visibleToViewer)
  const mine = visible.filter((t) => t.mine)
  const community = [...extraCommunity, ...visible.filter((t) => !t.mine)]
  return [...mine, ...community]
}
