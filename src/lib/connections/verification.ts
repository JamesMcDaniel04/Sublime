/**
 * Credential/connection verification state.
 *
 * The problem this solves: a connection whose token expired still looked
 * healthy in every picker, because nothing recorded whether it had ever worked.
 * `McpConnection.lastVerifiedAt` existed but was written only by the OAuth
 * callback — the pre-save "Test connection" button proved the credential worked
 * and then discarded the proof.
 *
 * Chosen over a hard save-time gate because a gate cannot express DRIFT (valid
 * at save time, expired a month later) and cannot cover OAuth
 * authorization-code flows, where the callback IS the test.
 *
 * NOT-YET-CHECKED MUST NEVER RENDER AS HEALTHY. That is the entire point: a
 * missing row is `unverified`, which the UI states plainly rather than dressing
 * up as a pass.
 */

/** Stale after this long — a check old enough to be worth repeating. */
export const VERIFY_STALE_MS = 7 * 24 * 60 * 60 * 1000

export type VerificationState = 'verified' | 'stale' | 'failed' | 'unverified'

export type VerificationRow = {
  state: string
  checkedAt: Date
  error?: string | null
}

export type Verification = {
  state: VerificationState
  checkedAt?: string
  error?: string
}

/**
 * Derive the display state. `failed` never decays to `stale`: a known failure
 * stays a failure until something proves otherwise, because "this broke" is
 * more actionable than "this is old".
 */
export function verificationState(row: VerificationRow | null | undefined, now = Date.now()): VerificationState {
  if (!row) return 'unverified'
  if (row.state === 'failed') return 'failed'
  if (row.state !== 'verified') return 'unverified'
  return now - row.checkedAt.getTime() > VERIFY_STALE_MS ? 'stale' : 'verified'
}

/** The shape surfaced to the client alongside a catalog entry. */
export function toVerification(row: VerificationRow | null | undefined, now = Date.now()): Verification {
  const state = verificationState(row, now)
  return {
    state,
    ...(row ? { checkedAt: row.checkedAt.toISOString() } : {}),
    // Only a failed state surfaces a reason. recordVerification already clears
    // the error on a pass, but deriving it defensively means a fixed connection
    // can never keep showing why it used to be broken.
    ...(state === 'failed' && row?.error ? { error: row.error } : {}),
  }
}

/** Plain-language label for a state — used by the builder and the checker. */
export function verificationLabel(state: VerificationState): string {
  switch (state) {
    case 'verified':
      return 'Verified'
    case 'stale':
      return 'Not checked recently'
    case 'failed':
      return 'Not working'
    default:
      // Deliberately not "unknown" — say what is missing, not that we are unsure.
      return 'Never used successfully'
  }
}

/**
 * Vault credentials are keyed with a prefix so one table covers every plane.
 * A generic credential (Bearer, Basic, header key) has no endpoint to probe, so
 * it can only earn `verified` from a real request that succeeded.
 */
export const credentialVerificationKey = (credentialId: string) => `credential:${credentialId}`
