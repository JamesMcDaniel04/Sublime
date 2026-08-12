/**
 * Who the platform belongs to, as an identity rather than as state.
 *
 * The operator tier (`platform:administer`) can read every tenant's rows. A
 * grant that broad must not be something a bug, a stray UPDATE, or a missing
 * environment variable can hand out, so the root of it is a closed list
 * compiled into the app:
 *
 *   - NOT an env var. An unset variable reads as empty, and an empty allowlist
 *     that is checked with `.includes()` fails CLOSED here but a misread one
 *     ("is this list empty? then allow everyone") fails open. Committing the
 *     list removes the question — and a deploy that changes it is a reviewable
 *     diff rather than a dashboard edit nobody sees.
 *   - NOT a database column alone. `users.platformRole` grants the tier for
 *     everyone else, but the owner must still be the owner if that column is
 *     wrong, cleared by a bad migration, or written by anything with DB access.
 *
 * Everyone else gets the tier from `users.platformRole` (see platform-roles.ts).
 * Editing this list is a code change on purpose.
 */

/**
 * Platform owner accounts. Lower-cased; compare via isPlatformOwnerEmail so
 * casing and stray whitespace can never decide an authorization question.
 */
const PLATFORM_OWNER_EMAILS: readonly string[] = ['hello@estimoto.io'] as const

/**
 * True for the platform's own accounts.
 *
 * Deliberately total on the null/empty case: a session with no email is not the
 * owner. That matters because `undefined === undefined` would otherwise make
 * every emailless actor an owner if this were written as a bare comparison.
 */
export function isPlatformOwnerEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return PLATFORM_OWNER_EMAILS.includes(email.trim().toLowerCase())
}
