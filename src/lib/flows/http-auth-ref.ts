/**
 * WHICH stored credential an http node authenticates with — the single
 * definition of that rule.
 *
 * It used to live in two places (the executor's `useGeneric` branch and the
 * credentials-tab inventory, which carried a comment promising to mirror it).
 * A third copy was about to be written for the audit trail, and an audit row
 * that disagrees with what actually authenticated the request is worse than no
 * row at all — so the rule is defined once and imported.
 *
 * The rule itself is unchanged: an explicit `authMode` decides, and a graph
 * written before the vault existed (no stored mode) infers from whichever
 * field is populated, with the connection winning when both are.
 */

export type HttpAuthRef =
  | { kind: 'none' }
  | { kind: 'credential'; credentialId: string }
  | { kind: 'connection'; connectionId: string }

const NONE: HttpAuthRef = { kind: 'none' }

const cleanString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export function resolveHttpAuthRef(fields: {
  authMode?: unknown
  credentialId?: unknown
  connectionId?: unknown
}): HttpAuthRef {
  const authMode = typeof fields.authMode === 'string' ? fields.authMode : undefined
  if (authMode === 'none') return NONE

  const credentialId = cleanString(fields.credentialId)
  const connectionId = cleanString(fields.connectionId)

  // Explicit `generic` means "use a vault credential". If none is set, fall
  // through to nothing rather than to a leftover connectionId — quietly
  // authenticating as a different identity than the author chose is worse
  // than sending the request unauthenticated and failing visibly.
  if (authMode === 'generic') return credentialId ? { kind: 'credential', credentialId } : NONE
  if (authMode === 'predefined') return connectionId ? { kind: 'connection', connectionId } : NONE

  if (!connectionId && credentialId) return { kind: 'credential', credentialId }
  if (connectionId) return { kind: 'connection', connectionId }
  return NONE
}
