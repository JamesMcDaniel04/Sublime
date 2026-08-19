/**
 * MFA step-up enforcement for privileged actions.
 *
 * The gap: TOTP enrollment exists but nothing server-side ever REQUIRED a
 * second factor, so a stolen AAL1 session was fully authorized — including
 * cross-owner admin takeover. Supabase carries the session's assurance level in
 * the `aal` JWT claim ('aal1' | 'aal2'); we stamp `users.mfaEnrolledAt` the
 * first time a session presents 'aal2' (definitive proof of a verified factor).
 *
 * The policy is deliberately NON-LOCKOUT and default-on:
 *   - not enrolled (mfaEnrolledAt null) → gate is inert; members are unaffected.
 *   - enrolled but the current session is explicitly 'aal1' → privileged actions
 *     are refused until the user steps up.
 *   - an unknown/absent aal (a token-refresh fallback path) does NOT block, so a
 *     transient auth path cannot lock an admin out.
 *
 * ALLOW_ADMIN_MFA_BYPASS=true is the operator break-glass — documented in the
 * runbook — for the rare case where enforcement must be lifted immediately
 * (e.g. an admin removed their factor and cannot re-enroll).
 */

/** True when a privileged action must be refused for want of a stepped-up session. */
export function mfaStepUpRequired(
  aal: string | undefined,
  mfaEnrolledAt: Date | null | undefined,
  bypass: boolean = process.env.ALLOW_ADMIN_MFA_BYPASS === 'true',
): boolean {
  if (bypass) return false
  if (!mfaEnrolledAt) return false
  // Block only on an EXPLICIT aal1. Unknown/absent aal is treated as
  // indeterminate rather than a downgrade, so a fallback auth path can't lock
  // an enrolled admin out.
  return aal === 'aal1'
}
