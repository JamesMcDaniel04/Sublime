/**
 * Where an in-app notification navigates when clicked.
 *
 * Flow notifications overload `executionId` to carry the FLOW id (a flow run id
 * is not resolvable by the dashboard). Jam notifications — including the invite
 * — deep-link STRAIGHT into the flow so a teammate lands in the live session,
 * not on the read-only activity page.
 */
export function notificationHref(n: { type: string; executionId?: string | null }): string {
  if (n.type.endsWith('.needs_approval')) return '/approvals'
  if (n.type.startsWith('flow.jam') && n.executionId) return `/flows/${n.executionId}` // straight into the jam
  if (n.type.startsWith('flow.') && n.executionId) return `/flows/${n.executionId}/activity`
  return n.executionId ? `/dashboard?run=${n.executionId}` : '/dashboard'
}
