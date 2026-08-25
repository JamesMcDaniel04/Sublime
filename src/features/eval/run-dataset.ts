import { prisma } from '@/lib/prisma'
import { scoreCase, summarizeRun, type CaseVerdict } from '@/lib/eval/scoring'

/**
 * Execute an evaluation dataset against an agent and persist the outcome.
 *
 * The existing `src/lib/eval` harness runs scripted fixtures offline in CI.
 * This runs the REAL agent, which is the difference between "the loop still
 * behaves" and "the agent still answers well" — the second is the question
 * that goes unanswered when a prompt changes.
 *
 * The run records the agent's VERSION, which is the point of persisting runs
 * at all: without it a stored score has no referent and "did this change make
 * it better" stays unanswerable.
 */
export async function runEvalDataset(params: {
  organizationId: string
  userId: string
  datasetId: string
  /** Injected so a test can drive this without a model. */
  execute?: (input: string) => Promise<string>
}): Promise<{ runId: string; passed: number; failed: number }> {
  const dataset = await prisma.evalDataset.findFirst({
    where: { id: params.datasetId, organizationId: params.organizationId },
    include: { cases: true },
  })
  if (!dataset) throw new Error('Dataset not found')
  if (!dataset.agentTaskId) throw new Error('This dataset is not attached to an agent')

  const agent = await prisma.agentTask.findFirst({
    where: { id: dataset.agentTaskId, organizationId: params.organizationId },
  })
  if (!agent) throw new Error('Agent not found')

  // The version that WILL run: an agent with a published config is evaluated
  // on what production executes, not on an unpublished draft. Evaluating the
  // draft would answer a question nobody asked.
  const run = await prisma.evalRun.create({
    data: {
      datasetId: dataset.id,
      organizationId: params.organizationId,
      agentTaskId: agent.id,
      agentVersion: agent.version,
      status: 'running',
    },
  })

  const execute =
    params.execute ??
    (async (input: string) => {
      // The real agent, not the scripted harness — the difference between
      // "the loop still behaves" and "the agent still answers well".
      const { runAgentExecution } = await import('@/features/agents/execute-agent')
      const result = await runAgentExecution({
        agentId: agent.id,
        organizationId: params.organizationId,
        userId: params.userId,
        input,
      } as never)
      const output = (result as { output?: unknown })?.output
      return typeof output === 'string' ? output : JSON.stringify(output ?? '')
    })

  const verdicts: CaseVerdict[] = []
  for (const evalCase of dataset.cases) {
    let output = ''
    let verdict: CaseVerdict
    try {
      output = await execute(evalCase.input)
      verdict = scoreCase(output, {
        mustContain: Array.isArray(evalCase.mustContain) ? (evalCase.mustContain as string[]) : [],
      })
    } catch (error) {
      // A case that THREW is a failure, not an omission. Skipping it would
      // quietly shrink the denominator and make a broken agent look better
      // the more cases it crashed on.
      verdict = { passed: false, notes: `Run failed: ${error instanceof Error ? error.message : 'unknown error'}` }
    }
    verdicts.push(verdict)
    await prisma.evalCaseResult.create({
      data: {
        runId: run.id,
        caseId: evalCase.id,
        organizationId: params.organizationId,
        passed: verdict.passed,
        ...(verdict.score !== undefined ? { score: verdict.score } : {}),
        output: output.slice(0, 10_000),
        notes: verdict.notes,
      },
    })
  }

  const summary = summarizeRun(verdicts)
  await prisma.evalRun.updateMany({
    where: { id: run.id, organizationId: params.organizationId },
    data: { status: 'completed', passed: summary.passed, failed: summary.failed, finishedAt: new Date() },
  })

  return { runId: run.id, passed: summary.passed, failed: summary.failed }
}
