import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { isValidScanExclusionEntry } from '@/lib/intelligence/scan-exclusions'
import { entitlementPlanFor, isGrandfatheredOrganization } from '@/lib/billing/entitlements'

const ORG_SELECT = { id: true, name: true, slug: true, plan: true, logoUrl: true, settings: true, createdAt: true, grandfatheredAt: true } as const

function serializeOrganization<T extends { plan: import('@prisma/client').Plan; createdAt: Date; grandfatheredAt?: Date | null }>(organization: T) {
  return {
    ...organization,
    plan: entitlementPlanFor(organization),
    grandfatheredAt: organization.grandfatheredAt ?? (isGrandfatheredOrganization(organization) ? organization.createdAt : null),
  }
}

// Organizations the user belongs to. Membership is single-org today; the
// shape is a list so the org switcher works unchanged when multi-org lands.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: ORG_SELECT,
  })
  return {
    success: true,
    activeOrganizationId: auth.organizationId,
    organizations: organization ? [serializeOrganization(organization)] : [],
  }
})

// Workspace logo: a small image data URL (the client resizes to 128px before
// uploading), stored inline so no external object storage is needed.
const LOGO_MAX_LENGTH = 300_000 // ~220KB of image data once base64-encoded

// Org settings is a free-form Json blob (default {}); only these keys are
// writable through this route — the update below merges onto the existing
// blob (never replaces it) so unrelated/future keys survive untouched.
const settingsPatchSchema = z.object({
  disableConnectionScans: z.boolean().optional(),
  knowledgeCaptureEnabled: z.boolean().optional(),
  captureAgentRunKnowledge: z.boolean().optional(),
  captureFlowRunKnowledge: z.boolean().optional(),
  captureConnectedKnowledge: z.boolean().optional(),
  retainKnowledgeOnDisconnect: z.boolean().optional(),
  zeroDataRetention: z.boolean().optional(),
  // Per-connection learning opt-out (Task 4.5): entries shaped
  // `<plane>:<connectionRef>` — the connections the usage scan must skip.
  // The full replacement array is sent each time (read-modify-write from the
  // client), same convention as disableConnectionScans above.
  scanExclusions: z.array(z.string().refine(isValidScanExclusionEntry, 'Invalid scan exclusion entry')).max(500).optional(),
})

const patchSchema = z.object({
  name: z.string().trim().min(1, 'Workspace name cannot be empty.').max(80).optional(),
  logoUrl: z
    .string()
    .max(LOGO_MAX_LENGTH, 'Image is too large — please use a smaller file.')
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Unsupported image format.')
    .nullable()
    .optional(),
  settings: settingsPatchSchema.optional(),
})

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const { name, logoUrl, settings } = patchSchema.parse(await request.json())

  let mergedSettings: Record<string, unknown> | undefined
  if (settings) {
    const existing = await prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: { settings: true, plan: true, createdAt: true, grandfatheredAt: true },
    })
    const existingSettings =
      existing?.settings && typeof existing.settings === 'object' && !Array.isArray(existing.settings)
        ? (existing.settings as Record<string, unknown>)
        : {}
    if (settings.zeroDataRetention === true && entitlementPlanFor(existing) !== 'ENTERPRISE') {
      throw new ApiError('Zero-data retention is available on Enterprise plans.', 403, 'PLAN_LIMIT')
    }
    mergedSettings = { ...existingSettings, ...settings }
  }

  const organization = await prisma.organization.update({
    where: { id: auth.organizationId },
    data: {
      ...(name !== undefined && { name }),
      ...(logoUrl !== undefined && { logoUrl }),
      ...(mergedSettings !== undefined && { settings: mergedSettings }),
    },
    select: ORG_SELECT,
  })
  return { success: true, organization: serializeOrganization(organization) }
})

// Delete the whole workspace: external resources (Nango connections, graph
// store) are deprovisioned best-effort, then the org row's FK cascades remove
// every owned row — including all member users, whose next sign-in
// re-provisions a fresh personal workspace. Admin-only and irreversible; the
// client confirms with a typed workspace name before calling.
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const { confirmName } = z.object({ confirmName: z.string() }).parse(await request.json())
  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { id: true, name: true },
  })
  if (!organization) throw new ApiError('Workspace not found', 404, 'NOT_FOUND')
  // Server-side confirmation: the typed name must match, so a stray API call
  // (or a stale client) can never delete a workspace by accident.
  if (confirmName.trim() !== organization.name.trim()) {
    throw new ApiError('The typed name does not match this workspace.', 400, 'CONFIRM_NAME_MISMATCH')
  }

  const members = await prisma.user.findMany({
    where: { organizationId: auth.organizationId },
    select: { supabaseId: true },
  })
  const { teardownOrganization } = await import('@/lib/org-teardown')
  await teardownOrganization(auth.organizationId)
  // Every member's cached user→workspace row now points at a dead org; bust
  // them so their next request re-provisions instead of wedging for the TTL.
  const { invalidateDbUserCache } = await import('@/lib/supabase/auth-utils')
  for (const member of members) invalidateDbUserCache(member.supabaseId)
  return { success: true }
})
