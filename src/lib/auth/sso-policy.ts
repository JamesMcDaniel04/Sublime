/**
 * Workspace SSO policy — domain claims, enforcement, and JIT provisioning.
 *
 * **The protocol is deliberately not ours.** SAML and OIDC are handled by
 * Supabase. XML signature validation is precisely where SSO implementations
 * break — signature wrapping, accepting unsigned assertions, XXE — and
 * hand-rolling it when the auth provider already does it correctly would be
 * adding risk to buy nothing.
 *
 * What Supabase cannot know is everything in this file: which workspace an
 * email domain belongs to, whether that workspace REQUIRES SSO, and what a
 * user provisioned on their first SSO login is allowed to do.
 */

export type SsoRole = 'MEMBER' | 'ADMIN'

export interface SsoPolicy {
  /** Password login refused for this workspace's domains. */
  enforced: boolean
  /** Domains this workspace claims, lowercased and de-duplicated. */
  domains: string[]
  /** The Supabase SSO provider id that actually performs the handshake. */
  providerId: string | null
  /** Role granted to a member provisioned on first SSO login. */
  defaultRole: SsoRole
}

/**
 * Domains no workspace may claim.
 *
 * Without this, one workspace claims gmail.com and every Google user who ever
 * signs in is routed into it — a total account takeover dressed up as a
 * configuration setting.
 */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'mail.com',
  'zoho.com', 'yandex.com', 'fastmail.com', 'tutanota.com', 'hey.com',
])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * Read a workspace's SSO policy from its settings blob.
 *
 * Two decisions here are load-bearing:
 *
 * Enforcement WITHOUT a configured provider is not honoured. This is the one
 * place the module fails open, and on purpose: honouring it would mean every
 * member is refused password login for a workspace that has no working way to
 * sign in — an unrecoverable state produced by a half-finished setup.
 *
 * `defaultRole` is clamped to MEMBER regardless of what is stored. If a
 * workspace could provision first-time SSO users straight to ADMIN, then
 * claiming a domain would be a privilege escalation rather than a routing
 * convenience.
 */
export function ssoPolicyFor(settings: unknown): SsoPolicy {
  const sso = record(record(settings).sso)
  const providerId = typeof sso.providerId === 'string' && sso.providerId.trim() ? sso.providerId.trim() : null

  const domains = [...new Set(
    (Array.isArray(sso.domains) ? sso.domains : [])
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry && !PUBLIC_EMAIL_DOMAINS.has(entry)),
  )]

  return {
    enforced: sso.enforced === true && providerId !== null,
    domains,
    providerId,
    // Never read from settings — see above.
    defaultRole: 'MEMBER',
  }
}

/** The domain part of an address, or null if it is not one address. */
function domainOf(email: string): string | null {
  const parts = email.trim().toLowerCase().split('@')
  if (parts.length !== 2) return null
  const [local, domain] = parts
  if (!local || !domain || !domain.includes('.')) return null
  return domain
}

export interface SsoOrganization {
  id: string
  settings: unknown
}

/**
 * The workspace claiming this email's domain, if any.
 *
 * Matching is on the WHOLE domain, never a suffix. A suffix match would let an
 * attacker register `evil-acme.com`, or use `mail.acme.com`, and be routed
 * into Acme's workspace — the classic way domain-claim features are broken.
 */
export function organizationForEmail(email: string, organizations: SsoOrganization[]): SsoOrganization | null {
  const domain = domainOf(email)
  if (!domain || PUBLIC_EMAIL_DOMAINS.has(domain)) return null

  return organizations.find((organization) =>
    ssoPolicyFor(organization.settings).domains.includes(domain),
  ) ?? null
}

export interface SsoEnforcementDecision {
  allowed: boolean
  organizationId: string | null
  /** True when an admin was let through a workspace that enforces SSO. */
  breakGlass: boolean
  reason?: string
}

/**
 * Whether a sign-in attempt may proceed.
 *
 * **The break-glass is deliberate.** An existing ADMIN keeps the password path
 * even under enforcement, because a misconfigured or expired identity provider
 * would otherwise lock an organisation out of its own workspace permanently,
 * with no way back in that does not involve us editing their database. It
 * narrows enforcement in exchange for making enforcement recoverable — the
 * same trade Okta and Google Workspace make.
 *
 * It applies only to someone who is ALREADY an admin of that workspace. A
 * caller who is not yet a member has no role to appeal to, so "I am an admin"
 * is never something the person signing in gets to assert.
 */
export function ssoEnforcementFor(
  email: string,
  organizations: SsoOrganization[],
  attempt: { method: 'password' | 'sso'; role: SsoRole | null },
): SsoEnforcementDecision {
  const organization = organizationForEmail(email, organizations)
  if (!organization) return { allowed: true, organizationId: null, breakGlass: false }

  const policy = ssoPolicyFor(organization.settings)
  if (!policy.enforced || attempt.method === 'sso') {
    return { allowed: true, organizationId: organization.id, breakGlass: false }
  }

  if (attempt.role === 'ADMIN') {
    return { allowed: true, organizationId: organization.id, breakGlass: true }
  }

  return {
    allowed: false,
    organizationId: organization.id,
    breakGlass: false,
    reason: 'This workspace requires single sign-on.',
  }
}

/**
 * How the current session was obtained, read from the token's `amr` claim.
 *
 * Enforcement cannot live in the login form: password sign-in runs
 * client-side against Supabase, so a client-side check is bypassed by calling
 * Supabase directly. It has to be decided server-side, per request, from the
 * token itself.
 *
 * Returns null when the token carries no `amr` — which happens on the getUser
 * fallback path. That is treated as INDETERMINATE and never as a violation:
 * locking a workspace out because a token could not be introspected would turn
 * a transient auth hiccup into an outage. The MFA gate in this codebase makes
 * the same call for the same reason.
 *
 * Anything that is not recognisably federated counts as `password`, so a new
 * or unexpected method is held to the stricter rule rather than waved through.
 */
export function authMethodFrom(claims: unknown): 'password' | 'sso' | null {
  const amr = claims && typeof claims === 'object' ? (claims as { amr?: unknown }).amr : undefined
  if (!Array.isArray(amr) || amr.length === 0) return null

  const methods = amr
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { method?: unknown }).method : entry))
    .filter((method): method is string => typeof method === 'string')
  if (methods.length === 0) return null

  const federated = methods.some((method) =>
    method.startsWith('sso') || method === 'oidc' || method === 'saml' || method === 'oauth',
  )
  return federated ? 'sso' : 'password'
}

/**
 * The per-request SSO gate, as `requireAuthContext` needs it.
 *
 * Extracted rather than left inline so the decision is tested directly — glue
 * between two well-tested functions is exactly where a security gate quietly
 * stops being applied.
 *
 * Every "admit" branch here is deliberate:
 *   - an unknown auth method is indeterminate, never a violation;
 *   - a user with no email on record has no domain to match;
 *   - an admin has the break-glass path (see ssoEnforcementFor).
 */
export function ssoGateFor(input: {
  email: string | null
  role: string | null
  authMethod: 'password' | 'sso' | null
  organization: SsoOrganization | null
}): SsoEnforcementDecision {
  if (!input.organization || !input.email || input.authMethod !== 'password') {
    return { allowed: true, organizationId: input.organization?.id ?? null, breakGlass: false }
  }
  return ssoEnforcementFor(input.email, [input.organization], {
    method: 'password',
    role: input.role === 'ADMIN' ? 'ADMIN' : 'MEMBER',
  })
}
