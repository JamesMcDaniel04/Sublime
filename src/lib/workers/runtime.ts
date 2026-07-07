import 'dotenv/config'
import Fastify from 'fastify'
import { Worker } from 'bullmq'
import { executeAgentJob } from '@/features/agents/execute-agent'
import { getRedisConnection, QUEUE_NAMES, workerConfig } from '@/lib/queue/config'
import { deadLetterFromJob } from '@/lib/queue/dead-letter'
import { registerAgentSchedules } from '@/lib/workers/agent-schedule-registrar'

class WorkerRuntime {
  private server = Fastify({ logger: true })
  private scheduleTimer?: NodeJS.Timeout
  private workers = [
    new Worker(QUEUE_NAMES.AGENT_EXECUTION, executeAgentJob, { ...workerConfig, connection: getRedisConnection() }),
    new Worker(QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION, executeAgentJob, { ...workerConfig, connection: getRedisConnection() }),
  ]

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
        workers: { 'agent-execution': this.workers[0].isRunning(), 'scheduled-agent-execution': this.workers[1].isRunning() },
        redis,
        uptime: process.uptime(),
      }
    })
    // Failed jobs (single attempt — no side-effect replay) are dead-lettered.
    const queues = [QUEUE_NAMES.AGENT_EXECUTION, QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION]
    this.workers.forEach((worker, index) => worker.on('failed', deadLetterFromJob(queues[index])))
    this.setupShutdown()
  }

  private setupShutdown() {
    const shutdown = async () => {
      if (this.scheduleTimer) clearInterval(this.scheduleTimer)
      await this.server.close()
      await Promise.all(this.workers.map((worker) => worker.close()))
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }

  async start(port = 3002) {
    await registerAgentSchedules()
    this.scheduleTimer = setInterval(() => {
      registerAgentSchedules().catch((error) => this.server.log.error(error, 'Schedule reconciliation failed'))
    }, 60_000)
    await this.server.listen({ port, host: '0.0.0.0' })
  }
}

if (require.main === module) {
  new WorkerRuntime().start(Number(process.env.WORKER_PORT) || 3002).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

export { WorkerRuntime }
