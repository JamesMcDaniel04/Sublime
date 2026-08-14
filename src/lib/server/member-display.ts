/**
 * How a teammate is named in a response.
 *
 * Four routes independently wrote `user.name || user.email || 'Teammate'` —
 * comments, credentials, goal work, and the people picker. It reads as a
 * harmless fallback, and for anyone who has set a display name it is. For
 * everyone who hasn't, it emits their FULL EMAIL ADDRESS to any member who can
 * see the surrounding object: a comment thread, a shared credential, a goal.
 *
 * That is the workspace directory leaking one row at a time through features
 * that only ever needed something to print.
 *
 * The local part is the compromise this settles on. A picker or a comment
 * byline has to identify a person — three rows reading "Teammate" is unusable —
 * and the local part is what colleagues call each other anyway, without being a
 * deliverable address. Workspace admins get the real thing from
 * /api/settings/members, which is what that endpoint is for.
 *
 * If a deployment wants even this withheld, change the middle term to
 * 'Teammate': every call site already tolerates a non-unique label.
 */
export function memberDisplayName(
  user: { name?: string | null; email?: string | null } | null | undefined,
): string {
  if (!user) return 'Teammate'
  const name = user.name?.trim()
  if (name) return name
  const local = user.email?.split('@')[0]?.trim()
  return local || 'Teammate'
}
