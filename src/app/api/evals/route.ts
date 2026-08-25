import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { summarizeRun, compareRuns, type CaseVerdict } from '@/lib/eval/scoring'
import { runEvalDataset } from '@/features/eval/run-dataset'

export const runtime = 'nodejs'
export const maxDuration = 800

/**
 * Evaluation datasets and runs.
 *
 * GET  — datasets with their latest run, and whether it improved or regressed
 * POST — create a dataset, add a case, or start a run
 *
 * The comparison is the feature. A pass count on its own tells nobody whether
 * the last prompt change helped; `improved | regressed | unchanged` against
 * the previous run is the answer people actually want.
 */

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('createDataset'),
    agentTaskId: z.string().min(1),
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
  }),
  z.object({
    action: z.literal('addCase'),
    datasetId: z.string().min(1),
    input: z.string().min(1).max(10_000),
    rubric: z.string().max(2_000).optional(),
    mustContain: z.array(z.string().max(500)).max(20).optional(),
  }),
  z.object({ action: z.literal('run'), datasetId: z.string().min(1) }),
])

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const datasets = await prisma.evalDataset.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: {
      _count: { select: { cases: true } },
      // Two most recent runs: the latest, and the one to compare it against.
      runs: {
        orderBy: { startedAt: 'desc' },
        take: 2,
        select: { id: true, status: true, passed: true, failed: true, agentVersion: true, startedAt: true },
      },
    },
  })

  const toSummary = (run: { passed: number; failed: number }) =>
    summarizeRun([
      ...Array.from({ length: run.passed }, () => ({ passed: true, notes: '' }) as CaseVerdict),
      ...Array.from({ length: run.failed }, () => ({ passed: false, notes: '' }) as CaseVerdict),
    ])

  return {
    success: true as const,
    datasets: datasets.map((dataset) => {
      const [latest, previous] = dataset.runs
      return {
        id: dataset.id,
        name: dataset.name,
        description: dataset.description,
        agentTaskId: dataset.agentTaskId,
        caseCount: dataset._count.cases,
        latestRun: latest ?? null,
        // Against the PREVIOUS run, so the answer is "did the last change
        // help", not "is this number big".
        trend: latest && previous ? compareRuns(toSummary(previous), toSummary(latest)) : 'unknown',
      }
    }),
  }
}, { requires: 'member' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = bodySchema.parse(await request.json())

  if (body.action === 'createDataset') {
    // Scoped find first: a crafted agentTaskId must not attach a dataset to
    // another workspace's agent.
    const agent = await prisma.agentTask.findFirst({
      where: { id: body.agentTaskId, organizationId: auth.organizationId },
      select: { id: true },
    })
    if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

    const dataset = await prisma.evalDataset.create({
      data: {
        organizationId: auth.organizationId,
        agentTaskId: agent.id,
        name: body.name,
        description: body.description ?? '',
      },
    })
    return { success: true as const, dataset }
  }

  if (body.action === 'addCase') {
    const dataset = await prisma.evalDataset.findFirst({
      where: { id: body.datasetId, organizationId: auth.organizationId },
      select: { id: true },
    })
    if (!dataset) throw new ApiError('Dataset not found', 404, 'NOT_FOUND')

    const evalCase = await prisma.evalCase.create({
      data: {
        datasetId: dataset.id,
        organizationId: auth.organizationId,
        input: body.input,
        rubric: body.rubric ?? '',
        mustContain: (body.mustContain ?? []) as never,
      },
    })
    return { success: true as const, case: evalCase }
  }

  const result = await runEvalDataset({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    datasetId: body.datasetId,
  })
  return { success: true as const, ...result }
}, { requires: 'member' })
