import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

const ORG_SELECT = { id: true, name: true, slug: true, plan: true, logoUrl: true, settings: true } as const

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
    organizations: organization ? [organization] : [],
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
})

const patchSchema = z.object({
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
  const { logoUrl, settings } = patchSchema.parse(await request.json())

  let mergedSettings: Record<string, unknown> | undefined
  if (settings) {
    const existing = await prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: { settings: true },
    })
    const existingSettings =
      existing?.settings && typeof existing.settings === 'object' && !Array.isArray(existing.settings)
        ? (existing.settings as Record<string, unknown>)
        : {}
    mergedSettings = { ...existingSettings, ...settings }
  }

  const organization = await prisma.organization.update({
    where: { id: auth.organizationId },
    data: {
      ...(logoUrl !== undefined && { logoUrl }),
      ...(mergedSettings !== undefined && { settings: mergedSettings }),
    },
    select: ORG_SELECT,
  })
  return { success: true, organization }
})
