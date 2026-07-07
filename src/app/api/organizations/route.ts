import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

// Organizations the user belongs to. Membership is single-org today; the
// shape is a list so the org switcher works unchanged when multi-org lands.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { id: true, name: true, slug: true, plan: true, logoUrl: true },
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
const logoSchema = z.object({
  logoUrl: z
    .string()
    .max(LOGO_MAX_LENGTH, 'Image is too large — please use a smaller file.')
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Unsupported image format.')
    .nullable(),
})

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const { logoUrl } = logoSchema.parse(await request.json())
  const organization = await prisma.organization.update({
    where: { id: auth.organizationId },
    data: { logoUrl },
    select: { id: true, name: true, slug: true, plan: true, logoUrl: true },
  })
  return { success: true, organization }
})
