import { z } from 'zod'
import { resolveTxt } from 'node:dns/promises'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { ssoPolicyFor, PUBLIC_EMAIL_DOMAINS } from '@/lib/auth/sso-policy'
import { domainVerificationToken, verifyDomainRecords, DOMAIN_TXT_PREFIX } from '@/lib/auth/domain-verification'

/**
 * Workspace SSO configuration.
 *
 * The SAML/OIDC handshake belongs to Supabase (see lib/auth/sso-policy.ts for
 * why). This route owns the parts Supabase cannot know: which domains the
 * workspace has PROVEN it controls, and whether password login is refused for
 * them.
 *
 * The claimed/verified split is the security backbone. A domain a workspace
 * merely asked for lives in `pending` and does nothing; it moves to `domains`
 * — the list `ssoPolicyFor` actually reads — only after a DNS TXT record
 * proves control. Skipping that step would let any workspace claim a
 * competitor's domain and capture their sign-ins.
 */

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claimDomain'), domain: z.string().min(3).max(253) }),
  z.object({ action: z.literal('verifyDomain'), domain: z.string().min(3).max(253) }),
  z.object({ action: z.literal('removeDomain'), domain: z.string().min(3).max(253) }),
  z.object({ action: z.literal('setProvider'), providerId: z.string().trim().max(200).nullable() }),
  z.object({ action: z.literal('setEnforced'), enforced: z.boolean() }),
])

/**
 * The secret the verification token is keyed with.
 *
 * Absent means domain verification cannot be performed at all, and the route
 * says so rather than falling back to a constant — a predictable key would let
 * anyone compute their own verification token and claim any domain, which is
 * the entire thing this mechanism exists to prevent.
 */
function verificationSecret(): string {
  const secret = process.env.DOMAIN_VERIFICATION_SECRET ?? process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!secret) {
    throw new ApiError('Domain verification is not configured on this deployment.', 503, 'SSO_UNCONFIGURED')
  }
  return secret
}

function ssoSettings(settings: unknown): { domains: string[]; pending: string[]; providerId: string | null; enforced: boolean } {
  const raw = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {}
  const sso = raw.sso && typeof raw.sso === 'object' ? (raw.sso as Record<string, unknown>) : {}
  const list = (value: unknown) =>
    (Array.isArray(value) ? value : []).filter((entry): entry is string => typeof entry === 'string')
  return {
    domains: list(sso.domains),
    pending: list(sso.pending),
    providerId: typeof sso.providerId === 'string' ? sso.providerId : null,
    enforced: sso.enforced === true,
  }
}

async function loadOrganization(organizationId: string) {
  const organization = await prisma.organization.findFirstOrThrow({
    where: { id: organizationId },
    select: { id: true, settings: true },
  })
  return organization
}

async function writeSso(
  organizationId: string,
  settings: unknown,
  next: Partial<{ domains: string[]; pending: string[]; providerId: string | null; enforced: boolean }>,
) {
  const raw = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {}
  const current = ssoSettings(settings)
  await prisma.organization.update({
    where: { id: organizationId },
    data: { settings: { ...raw, sso: { ...current, ...next } } as never },
  })
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organization = await loadOrganization(auth.organizationId)
  const stored = ssoSettings(organization.settings)
  const policy = ssoPolicyFor(organization.settings)

  return {
    success: true,
    // What is actually in force, as the sign-in path will read it.
    enforced: policy.enforced,
    domains: policy.domains,
    providerId: policy.providerId,
    // Claimed but unproven — listed with the record each one needs, so the
    // person setting this up can copy it straight into their DNS.
    pending: stored.pending.map((domain) => ({
      domain,
      recordName: `_sublime.${domain}`,
      recordType: 'TXT',
      recordValue: domainVerificationToken(auth.organizationId, domain, verificationSecret()),
    })),
    // Surfaced so the UI can explain why enforcement is off despite the toggle.
    enforcementBlocked: stored.enforced && !policy.enforced
      ? 'Set an identity provider before single sign-on can be required.'
      : null,
  }
}, { requires: 'settings:workspace' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = bodySchema.parse(await request.json())
  const organization = await loadOrganization(auth.organizationId)
  const stored = ssoSettings(organization.settings)

  if (body.action === 'setProvider') {
    await writeSso(auth.organizationId, organization.settings, { providerId: body.providerId?.trim() || null })
    await recordAudit({
      organizationId: auth.organizationId, actorUserId: auth.dbUser.id,
      action: 'sso.provider.set', resourceType: 'organization', resourceId: auth.organizationId,
      detail: { providerId: body.providerId ?? null },
    })
    return { success: true }
  }

  if (body.action === 'setEnforced') {
    await writeSso(auth.organizationId, organization.settings, { enforced: body.enforced })
    await recordAudit({
      organizationId: auth.organizationId, actorUserId: auth.dbUser.id,
      action: body.enforced ? 'sso.enforced' : 'sso.unenforced',
      resourceType: 'organization', resourceId: auth.organizationId,
      detail: { domains: stored.domains },
    })
    // Enforcement with no verified domain applies to nobody. Saying so beats
    // letting an admin believe the workspace is protected when it is not.
    return {
      success: true,
      warning: body.enforced && stored.domains.length === 0
        ? 'No verified domain yet, so this does not apply to anyone.'
        : undefined,
    }
  }

  const domain = body.domain.trim().toLowerCase().replace(/\.$/, '')
  if (!DOMAIN_RE.test(domain)) throw new ApiError('That is not a valid domain.', 400, 'INVALID_DOMAIN')
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
    throw new ApiError('A public email domain cannot be claimed.', 400, 'PUBLIC_DOMAIN')
  }

  if (body.action === 'removeDomain') {
    await writeSso(auth.organizationId, organization.settings, {
      domains: stored.domains.filter((entry) => entry !== domain),
      pending: stored.pending.filter((entry) => entry !== domain),
    })
    await recordAudit({
      organizationId: auth.organizationId, actorUserId: auth.dbUser.id,
      action: 'sso.domain.removed', resourceType: 'organization', resourceId: auth.organizationId,
      detail: { domain },
    })
    return { success: true }
  }

  if (body.action === 'claimDomain') {
    if (stored.domains.includes(domain) || stored.pending.includes(domain)) {
      throw new ApiError('That domain is already claimed here.', 409, 'ALREADY_CLAIMED')
    }
    // Claimed elsewhere and VERIFIED is a hard stop: the other workspace has
    // proven control, so this one cannot take it. A merely-pending claim
    // elsewhere is not a blocker — two workspaces may both be mid-setup, and
    // only the one that publishes the record wins.
    const conflict = await prisma.organization.findFirst({
      where: { settings: { path: ['sso', 'domains'], array_contains: [domain] } as never },
      select: { id: true },
    })
    if (conflict && conflict.id !== auth.organizationId) {
      throw new ApiError('Another workspace has already verified that domain.', 409, 'DOMAIN_TAKEN')
    }

    await writeSso(auth.organizationId, organization.settings, { pending: [...stored.pending, domain] })
    return {
      success: true,
      // Returned immediately so setup is one step, not two.
      recordName: `_sublime.${domain}`,
      recordType: 'TXT',
      recordValue: domainVerificationToken(auth.organizationId, domain, verificationSecret()),
    }
  }

  // verifyDomain
  if (!stored.pending.includes(domain)) {
    throw new ApiError('Claim that domain before verifying it.', 400, 'NOT_CLAIMED')
  }

  const expected = domainVerificationToken(auth.organizationId, domain, verificationSecret())
  let records: string[][] = []
  try {
    records = await resolveTxt(`_sublime.${domain}`)
  } catch {
    // NXDOMAIN and a lookup failure are indistinguishable to the person
    // setting this up, and both mean the same thing: not verified yet.
    records = []
  }

  if (!verifyDomainRecords(records, expected)) {
    throw new ApiError(
      `No matching ${DOMAIN_TXT_PREFIX} record found at _sublime.${domain}. DNS can take a few minutes to propagate.`,
      400,
      'VERIFICATION_FAILED',
    )
  }

  await writeSso(auth.organizationId, organization.settings, {
    domains: [...stored.domains, domain],
    pending: stored.pending.filter((entry) => entry !== domain),
  })
  await recordAudit({
    organizationId: auth.organizationId, actorUserId: auth.dbUser.id,
    action: 'sso.domain.verified', resourceType: 'organization', resourceId: auth.organizationId,
    detail: { domain },
  })
  return { success: true, domain }
}, { requires: 'settings:workspace' })
