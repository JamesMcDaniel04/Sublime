import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Proving a workspace controls a domain before it may claim it for SSO.
 *
 * Without this step the SSO policy is a vulnerability rather than a feature.
 * Domain claiming decides where a person's sign-in is ROUTED, so an unverified
 * claim on `competitor.com` would deliver that competitor's users into the
 * claimant's workspace. A DNS TXT record is the standard proof precisely
 * because publishing one requires control of the domain.
 */

/** Identifies our record in a zone file someone else has to read. */
export const DOMAIN_TXT_PREFIX = 'sublime-domain-verification='

/**
 * The token a workspace must publish to claim a domain.
 *
 * HMAC over BOTH the workspace and the domain, keyed by a server-side secret.
 * Each half of that is load-bearing:
 *
 *   - including the domain stops one published record from verifying every
 *     domain a workspace might want to claim;
 *   - including the workspace id stops a hostile workspace verifying against
 *     the record the domain's real owner already published — which would
 *     otherwise be the easy bypass, since that record is public by nature;
 *   - keying it with a server secret stops the person claiming the domain from
 *     computing the token themselves.
 */
export function domainVerificationToken(organizationId: string, domain: string, secret: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${organizationId}:${domain.trim().toLowerCase()}`)
    .digest('hex')
  return `${DOMAIN_TXT_PREFIX}${digest}`
}

/** Constant-time compare of two same-purpose strings. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Whether the published TXT records prove the claim.
 *
 * `records` is the shape a DNS resolver returns: a list of records, each a
 * list of strings, because a resolver splits a long TXT value into chunks.
 * Joining the chunks is required — a token that happens to span a chunk
 * boundary would otherwise fail for no reason the user could diagnose.
 *
 * The comparison is on the WHOLE joined value, so a record that merely
 * contains the token (`...=<token>-not-really`) does not pass.
 */
export function verifyDomainRecords(records: string[][], expected: string): boolean {
  return records.some((chunks) => equals(chunks.join('').trim(), expected))
}
