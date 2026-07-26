import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const input = z
    .object({
      laborHourlyRate: z.number().positive().max(10_000).optional(),
      aiCostPerMTokensUsd: z.number().positive().max(10_000).optional(),
    })
    .refine((body) => Object.keys(body).length > 0, { message: 'No settings supplied.' })
    .parse(await request.json().catch(() => ({})))
  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { settings: true },
  })
  const existing =
    organization?.settings &&
    typeof organization.settings === 'object' &&
    !Array.isArray(organization.settings)
      ? (organization.settings as Record<string, unknown>)
      : {}
  await prisma.organization.update({
    where: { id: auth.organizationId },
    data: { settings: { ...existing, ...input } },
  })
  return { success: true }
})
