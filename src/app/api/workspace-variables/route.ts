import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { normalizeVariableKey, variableKeyProblem } from '@/lib/flows/workspace-vars'

export const runtime = 'nodejs'

/**
 * Workspace variables — the values behind `{{workspace.<key>}}`.
 *
 * Reading is open to any member: these are constants a flow author needs to
 * see to write a flow, and they are plain text by construction.
 *
 * Writing requires `settings:workspace`. A variable is shared state — one
 * person changing `sales_channel` changes every flow that reads it, including
 * flows they do not own — so it sits with the other workspace-wide settings
 * rather than with flow editing.
 *
 * The credential guard runs HERE as well as in the UI, because the UI is not
 * the only write path and a plaintext table that quietly accumulates tokens
 * would be worse than not having variables at all.
 */

const upsertSchema = z.object({
  key: z.string().min(1).max(64),
  value: z.string().max(4000),
  description: z.string().max(280).optional(),
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const variables = await prisma.workspaceVariable.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { key: 'asc' },
    select: { id: true, key: true, value: true, description: true, updatedAt: true },
  })
  return { success: true as const, variables }
}, { requires: 'member' })

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = upsertSchema.parse(await request.json())
  const key = normalizeVariableKey(body.key)

  const problem = variableKeyProblem(key)
  if (problem) throw new ApiError(problem, 400, 'INVALID_VARIABLE_KEY')

  // Upsert on the unique (organizationId, key): two people adding the same
  // key concurrently should converge rather than one of them erroring.
  const variable = await prisma.workspaceVariable.upsert({
    where: { organizationId_key: { organizationId: auth.organizationId, key } },
    create: {
      organizationId: auth.organizationId,
      key,
      value: body.value,
      description: body.description ?? '',
    },
    update: {
      value: body.value,
      ...(body.description !== undefined ? { description: body.description } : {}),
    },
    select: { id: true, key: true, value: true, description: true, updatedAt: true },
  })
  return { success: true as const, variable }
}, { requires: 'settings:workspace' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { key } = z.object({ key: z.string().min(1) }).parse(await request.json())
  // deleteMany, not delete: scoped by organizationId so a key from another
  // workspace can never be addressed, and a missing key is a no-op rather
  // than a 500.
  const result = await prisma.workspaceVariable.deleteMany({
    where: { organizationId: auth.organizationId, key: normalizeVariableKey(key) },
  })
  if (result.count === 0) throw new ApiError('No such variable', 404, 'NOT_FOUND')
  return { success: true as const }
}, { requires: 'settings:workspace' })
