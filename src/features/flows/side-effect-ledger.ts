import { createHash } from 'crypto'
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'

export type FlowEffectSafety = 'read' | 'idempotent_write' | 'unsafe_write'

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`
}

export function sideEffectRequestHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function sideEffectKey(params: {
  flowRunId: string
  nodeId: string
  iterationPath?: string | null
  kind: 'tool' | 'http'
}): string {
  return createHash('sha256')
    .update(`${params.flowRunId}\u0000${params.nodeId}\u0000${params.iterationPath ?? ''}\u0000${params.kind}`)
    .digest('hex')
}

export function providerIdempotencyKey(effectKey: string): string {
  return `sublime-flow-${effectKey.slice(0, 40)}`
}

export class AmbiguousSideEffectError extends Error {
  readonly code = 'FLOW_SIDE_EFFECT_AMBIGUOUS'

  constructor(message: string) {
    super(message)
    this.name = 'AmbiguousSideEffectError'
  }
}

type ClaimParams = {
  organizationId: string
  flowRunId: string
  flowRunStepId: string
  nodeId: string
  iterationPath?: string | null
  kind: 'tool' | 'http'
  provider: string
  operation: string
  safety: FlowEffectSafety
  request: unknown
}

export type SideEffectClaim =
  | { mode: 'execute'; id: string; effectKey: string; providerKey?: string }
  | { mode: 'replay'; id: string; output: unknown }

async function existingClaim(params: ClaimParams, effectKey: string, requestHash: string): Promise<SideEffectClaim | null> {
  const existing = await prisma.flowSideEffect.findFirst({
    where: { effectKey, organizationId: params.organizationId },
  })
  if (!existing) return null
  if (existing.requestHash !== requestHash) {
    throw new Error('Side-effect identity was reused with a different request. Start a new flow run before retrying this action.')
  }
  if (existing.status === 'succeeded') {
    return { mode: 'replay', id: existing.id, output: existing.response }
  }
  if (params.safety === 'unsafe_write' && (existing.status === 'claimed' || existing.status === 'ambiguous')) {
    await prisma.flowSideEffect.updateMany({
      where: { id: existing.id, organizationId: params.organizationId },
      data: { status: 'ambiguous' },
    })
    throw new AmbiguousSideEffectError(
      `The prior ${params.operation} call may have completed at the provider. Automatic replay is blocked because this action has no provider idempotency key. Verify the provider result, then replay from the operations console.`,
    )
  }
  await prisma.flowSideEffect.updateMany({
    where: { id: existing.id, organizationId: params.organizationId },
    data: {
      flowRunStepId: params.flowRunStepId,
      status: 'claimed',
      lastError: null,
      completedAt: null,
    },
  })
  return {
    mode: 'execute',
    id: existing.id,
    effectKey,
    ...(existing.providerKey ? { providerKey: existing.providerKey } : {}),
  }
}

export async function claimSideEffect(params: ClaimParams): Promise<SideEffectClaim> {
  const effectKey = sideEffectKey(params)
  const requestHash = sideEffectRequestHash(params.request)
  const existing = await existingClaim(params, effectKey, requestHash)
  if (existing) return existing

  const providerKey = params.safety === 'idempotent_write' ? providerIdempotencyKey(effectKey) : undefined
  try {
    const created = await prisma.flowSideEffect.create({
      data: {
        organizationId: params.organizationId,
        flowRunId: params.flowRunId,
        flowRunStepId: params.flowRunStepId,
        effectKey,
        nodeId: params.nodeId,
        iterationPath: params.iterationPath ?? null,
        kind: params.kind,
        provider: params.provider,
        operation: params.operation,
        safety: params.safety,
        providerKey,
        requestHash,
      },
    })
    return { mode: 'execute', id: created.id, effectKey, ...(providerKey ? { providerKey } : {}) }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await existingClaim(params, effectKey, requestHash)
      if (raced) return raced
    }
    throw error
  }
}

export async function recordSideEffectAttempt(id: string, organizationId: string): Promise<void> {
  await prisma.flowSideEffect.updateMany({
    where: { id, organizationId, status: 'claimed' },
    data: { attempts: { increment: 1 }, startedAt: new Date() },
  })
}

export async function completeSideEffect(params: {
  id: string
  organizationId: string
  output: unknown
  providerRequestId?: string
}): Promise<void> {
  await prisma.flowSideEffect.updateMany({
    where: { id: params.id, organizationId: params.organizationId, status: 'claimed' },
    data: {
      status: 'succeeded',
      response: params.output === undefined ? Prisma.JsonNull : (params.output as Prisma.InputJsonValue),
      providerRequestId: params.providerRequestId,
      lastError: null,
      completedAt: new Date(),
    },
  })
}

export async function failSideEffect(params: {
  id: string
  organizationId: string
  error: unknown
  ambiguous: boolean
}): Promise<void> {
  const message = params.error instanceof Error ? params.error.message : String(params.error)
  await prisma.flowSideEffect.updateMany({
    where: { id: params.id, organizationId: params.organizationId, status: 'claimed' },
    data: {
      status: params.ambiguous ? 'ambiguous' : 'failed',
      lastError: message.slice(0, 1000),
      completedAt: new Date(),
    },
  })
}
