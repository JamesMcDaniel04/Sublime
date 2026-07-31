import 'dotenv/config'
import Fastify from 'fastify'
import { Worker, type Processor } from 'bullmq'
import { executeAgentJob } from '@/features/agents/execute-agent'
import { executeFlowJob } from '@/features/flows/execute-flow'
import { getRedisConnection, QUEUE_NAMES, queueConcurrency, workerConfig } from '@/lib/queue/config'
import { deadLetterFromJob } from '@/lib/queue/dead-letter'
import { deadLetterFromFlowJob } from '@/lib/queue/flow-dead-letter'
import { registerAgentSchedules } from '@/lib/workers/agent-schedule-registrar'
import { initSentry, captureError, flushErrorReporting } from '@/lib/observability/sentry'
import { executeActivityBackfillJob } from '@/lib/activity/backfill'

class WorkerRuntime {
  private server = Fastify({ logger: true })
  private scheduleTimer?: NodeJS.Timeout
  // handler is typed as the generic BullMQ Processor so this array (mixing
  // the agent- and flow-job handler signatures) unifies to one element type —
  // each queue is still wired to its own correctly-typed handler at runtime.
  private workerSpecs: { queue: string; handler: Processor<any, any, string>; onFailed: (job: any, error: Error) => void }[] = [
    { queue: QUEUE_NAMES.AGENT_EXECUTION, handler: executeAgentJob, onFailed: deadLetterFromJob(QUEUE_NAMES.AGENT_EXECUTION) },
    { queue: QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION, handler: executeAgentJob, onFailed: deadLetterFromJob(QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION) },
    // Flow execution: same worker pool, its own queue and dead-letter target
    // (flowRun rows, not agentExecution rows) — see flow-dead-letter.ts.
    { queue: QUEUE_NAMES.FLOW_EXECUTION, handler: executeFlowJob, onFailed: deadLetterFromFlowJob(QUEUE_NAMES.FLOW_EXECUTION) },
    {
      queue: QUEUE_NAMES.ACTIVITY_BACKFILL,
      handler: executeActivityBackfillJob,
      // Backfills have no dead-letter table, but their failures must still be
      // visible — a silently-dead backfill leaves the activity ledger empty
      // with no operator signal.
      onFailed: (job: any, error: Error) => captureError(error, { source: 'worker.activity-backfill', jobId: job?.id }),
    },
  ]
  private workers = this.workerSpecs.map(
    (spec) =>
      new Worker(spec.queue, spec.handler, {
        ...workerConfig,
        concurrency: queueConcurrency[spec.queue] ?? workerConfig.concurrency,
        connection: getRedisConnection(),
      }),
  )
  private shuttingDown = false

  constructor() {
    // Real readiness: reflect that the workers are running AND Redis is
    // reachable. A dead Redis connection means the worker consumes nothing —
    // returning 503 lets Docker's healthcheck/restart policy recycle it instead
    // of leaving a silently-dead worker reporting healthy.
    this.server.get('/health', async (_request, reply) => {
      const running = this.workers.every((worker) => worker.isRunning())
      let redis = false
      try {
        redis = (await getRedisConnection().ping()) === 'PONG'
      } catch {
        redis = false
      }
      const healthy = running && redis
      reply.code(healthy ? 200 : 503)
      return {
        status: healthy ? 'healthy' : 'unhealthy',
        workers: Object.fromEntries(this.workerSpecs.map((spec, index) => [spec.queue, this.workers[index].isRunning()])),
        redis,
        uptime: process.uptime(),
      }
    })
    // Failed jobs are dead-lettered (durable, inspectable) — see workerSpecs
    // above for the per-queue handler (agent vs. flow target different tables).
    this.workers.forEach((worker, index) => worker.on('failed', this.workerSpecs[index].onFailed))
    // Without an 'error' listener, BullMQ reduces connection failures (Redis
    // auth/disconnect/reconnect storms) to a bare console.error — invisible to
    // Sentry and to any operator not tailing Render logs.
    this.workers.forEach((worker) => worker.on('error', (error) => captureError(error, { source: 'worker.queue-error' })))
    this.setupShutdown()
  }

  private setupShutdown() {
    const shutdown = async () => {
      // Re-entrant SIGTERM/SIGINT must not run two concurrent shutdowns.
      if (this.shuttingDown) return
      this.shuttingDown = true
      if (this.scheduleTimer) clearInterval(this.scheduleTimer)
      // Stop taking new jobs immediately; in-flight jobs keep running.
      await Promise.allSettled(this.workers.map((worker) => worker.pause(true)))
      await this.server.close()
      // Bounded drain: Render SIGKILLs ~30s after SIGTERM, and agent runs are
      // budgeted at 20 minutes — waiting for them means dying mid-close with
      // Sentry unflushed and job locks orphaned. Give in-flight jobs 20s, then
      // force-close: the stalled-job checker re-delivers, and durable resume
      // continues from the last checkpointed turn instead of re-firing side
      // effects.
      const drained = Promise.all(this.workers.map((worker) => worker.close())).then(() => 'drained' as const)
      const deadline = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20_000))
      if ((await Promise.race([drained, deadline])) === 'timeout') {
        await Promise.allSettled(this.workers.map((worker) => worker.close(true)))
      }
      await flushErrorReporting()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }

  async start(port = 3002) {
    // Fail fast on missing required env; warn loudly on missing observability
    // env. The worker previously ran no validation at all — which is how it
    // shipped without SENTRY_DSN (errors console-only) and VAPID keys (push
    // silently dead in production).
    const { assertWorkerEnv } = await import('@/lib/env')
    assertWorkerEnv(this.server.log)
    await initSentry('worker')
    // Reports and keeps running — does NOT exit, unlike uncaughtException
    // below. A single unhandled rejection in one BullMQ job must not take
    // down every other in-flight job on this worker; we'd rather report and
    // stay up than let one bad promise kill the process.
    process.on('unhandledRejection', (reason) => {
      captureError(reason, { source: 'worker.unhandledRejection' })
    })
    process.on('uncaughtException', (error) => {
      captureError(error, { source: 'worker.uncaughtException' })
      void flushErrorReporting().finally(() => process.exit(1))
    })
    await registerAgentSchedules()
    this.scheduleTimer = setInterval(() => {
      registerAgentSchedules().catch((error) => this.server.log.error(error, 'Schedule reconciliation failed'))
    }, 60_000)
    await this.server.listen({ port, host: '0.0.0.0' })
  }
}

if (require.main === module) {
  new WorkerRuntime().start(Number(process.env.WORKER_PORT) || 3002).catch(async (error) => {
    console.error(error)
    captureError(error, { source: 'worker.start' })
    await flushErrorReporting()
    process.exit(1)
  })
}

export { WorkerRuntime }
