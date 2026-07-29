import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { buildCredentialConfig, redactCredential } from '@/lib/credentials/config'
import { credentialScope } from '@/lib/credentials/resolve'
import { CREDENTIAL_TYPES, type CredentialType } from '@/lib/credentials/types'
import { loadVerifications } from '@/lib/connections/record-verification'
import { credentialVerificationKey, toVerification } from '@/lib/connections/verification'

export const runtime = 'nodejs'

// GET/POST /api/credentials — the reusable credential vault.
//
// Reads are ALWAYS redacted: a secret enters through POST/PUT and leaves only
// through the server-side resolver at fetch time. No route ever returns a
// decrypted value.

// `value` is optional on update — a blank one means "keep the stored secret",
// resolved against `originalName` so a renamed row keeps its value. The list
// itself is authoritative, so an omitted row is a deletion.
const entrySchema = z.object({
  name: z.string(),
  value: z.string().optional(),
  originalName: z.string().optional(),
})

export const credentialInputSchema = z.object({
  type: z.enum(CREDENTIAL_TYPES as unknown as [CredentialType, ...CredentialType[]]),
  username: z.string().optional(),
  password: z.string().optional(),
  token: z.string().optional(),
  headerName: z.string().optional(),
  queryParam: z.string().optional(),
  key: z.string().optional(),
  headers: z.array(entrySchema).optional(),
  query: z.array(entrySchema).optional(),
  caCert: z.string().max(100_000).optional(),
  consumerKey: z.string().optional(),
  consumerSecret: z.string().optional(),
  accessToken: z.string().optional(),
  tokenSecret: z.string().optional(),
  signatureMethod: z.enum(['HMAC-SHA1', 'HMAC-SHA256']).optional(),
  grantType: z.enum(['staticToken', 'clientCredentials']).optional(),
  tokenUrl: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
  audience: z.string().optional(),
  clientAuth: z.enum(['header', 'body']).optional(),
})

const createSchema = credentialInputSchema.extend({
  name: z.string().min(1, 'Give this credential a name.'),
  /** Personal to the creator when true; org-shared otherwise. */
  personal: z.boolean().optional(),
  allowedDomains: z.array(z.string()).optional(),
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const rows = await prisma.credential.findMany({
    where: credentialScope(auth.organizationId, auth.dbUser.id),
    orderBy: { name: 'asc' },
    select: { id: true, name: true, type: true, authConfig: true, allowedDomains: true, userId: true, lastUsedAt: true, updatedAt: true },
  })
  const verifications = await loadVerifications(
    auth.organizationId,
    rows.map((row) => credentialVerificationKey(row.id)),
  )
  return {
    success: true,
    credentials: rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      allowedDomains: row.allowedDomains,
      personal: row.userId !== null,
      lastUsedAt: row.lastUsedAt,
      updatedAt: row.updatedAt,
      verification: toVerification(verifications.get(credentialVerificationKey(row.id))),
      config: redactCredential(row.type, row.authConfig),
    })),
  }
}, { requires: 'member' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = createSchema.parse(await request.json().catch(() => ({})))
  const userId = input.personal ? auth.dbUser.id : null

  // Postgres treats NULL as distinct in a unique key, so org-shared name
  // uniqueness has to be enforced here rather than by the index.
  const clash = await prisma.credential.findFirst({
    where: { organizationId: auth.organizationId, userId, name: input.name },
    select: { id: true },
  })
  if (clash) throw new ApiError('A credential with that name already exists.', 409, 'DUPLICATE_NAME')

  const row = await prisma.credential.create({
    data: {
      organizationId: auth.organizationId,
      userId,
      name: input.name,
      type: input.type,
      authConfig: buildCredentialConfig(input),
      allowedDomains: input.allowedDomains ?? [],
      createdById: auth.dbUser.id,
    },
    select: { id: true, name: true, type: true, authConfig: true, allowedDomains: true, userId: true },
  })
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'credential.create',
    resourceType: 'credential',
    resourceId: row.id,
    // Name and type only — never the config, even hashed.
    detail: { name: row.name, type: row.type },
  })
  return {
    success: true,
    credential: {
      id: row.id,
      name: row.name,
      type: row.type,
      allowedDomains: row.allowedDomains,
      personal: row.userId !== null,
      config: redactCredential(row.type, row.authConfig),
    },
  }
}, { requires: 'member' })
