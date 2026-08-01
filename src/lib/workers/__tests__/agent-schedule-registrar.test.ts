/**
 * repeatFor() (schedule -> BullMQ repeat translation) is module-private, so it
 * is observed through the smallest exported seam: registerAgentSchedules().
 * ACTIVE agents are seeded in the QA Postgres, and the scheduler queue's
 * INSTANCE methods are stubbed (getQueue/getRedisConnection memoize singletons,
 * so the registrar sees the same patched objects) — no Redis is contacted:
 * the worker connection never issues a command (set is stubbed) and the
 * producer connection's connect() is a no-op, so lazyConnect never dials out.
 *
 * Inert without TEST_DATABASE_URL, like the other .pg tests.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  // Dead port on purpose; nothing may actually connect (connect is stubbed).
  process.env.REDIS_URL = 'redis://127.0.0.1:6398'
  delete process.env.BULLMQ_DISABLE

  let systemPrisma: any
  let seeded: any
  let redisConn: any
  let producerConn: any
  let resetErrorReporter: (() => void) | undefined
  let registerAgentSchedules: () => Promise<any>

  const upserts = new Map<string, { repeat: any; opts: any }>()
  const agentIds = new Map<string, string>()
  const keyOf = (label: string) => `agent:${agentIds.get(label)}`
  const upsertOf = (label: string) => upserts.get(keyOf(label))
  let result: any

  before(async () => {
    const sentry = await import('@/lib/observability/sentry')
    sentry.setErrorReporter(() => {})
    resetErrorReporter = sentry.resetErrorReporter

    const cfg = await import('@/lib/queue/config')
    redisConn = cfg.getRedisConnection()
    // Registrar lock: pretend the SET NX succeeded without touching Redis.
    redisConn.set = async () => 'OK'
    producerConn = cfg.getProducerConnection()
    producerConn.connect = async () => {}
    // BullMQ reads this off the ioredis instance's options: skips the INFO
    // version probe, so Queue construction issues zero Redis commands.
    producerConn.options.skipVersionCheck = true
    // Anything else BullMQ fires at the connection (e.g. the Queue meta hset
    // on ready) resolves inertly instead of timing out on the offline queue.
    producerConn.sendCommand = async () => null

    const queue: any = cfg.getQueue(cfg.QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION)
    queue.upsertJobScheduler = async (id: string, repeat: any, opts: any) => {
      upserts.set(id, { repeat, opts })
    }
    queue.getJobSchedulers = async () => []
    queue.removeJobScheduler = async () => {}

    ;({ systemPrisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(systemPrisma)

    const schedules: Record<string, unknown> = {
      cron: { type: 'cron', cron: '*/5 * * * *', timezone: 'America/New_York', isActive: true },
      hourly: { type: 'hourly', isActive: true },
      daily: { type: 'daily', time: '07:30', timezone: 'Europe/London', isActive: true },
      weekly: { type: 'weekly', time: '18:05', isActive: true },
      dailyNoTime: { type: 'daily', isActive: true },
      dailySingleField: { type: 'daily', time: '8', isActive: true },
      dailyGarbageTime: { type: 'daily', time: 'noon', isActive: true },
      cronMissingExpression: { type: 'cron', timezone: 'UTC', isActive: true },
      unknownType: { type: 'fortnightly', isActive: true },
      inactive: { type: 'hourly', isActive: false },
      notAnObject: 'hourly',
    }
    for (const [label, schedule] of Object.entries(schedules)) {
      const agent = await systemPrisma.agentTask.create({
        data: {
          description: `registrar test: ${label}`,
          objective: `objective for ${label}`,
          schedule,
          status: 'ACTIVE',
          organizationId: seeded.organizationId,
          // One agent is owner-less to drive the oldest-active-member fallback.
          userId: label === 'hourly' ? null : seeded.userId,
        },
      })
      agentIds.set(label, agent.id)
    }

    ;({ registerAgentSchedules } = await import('@/lib/workers/agent-schedule-registrar'))
    result = await registerAgentSchedules()
  })

  after(async () => {
    if (seeded) await seeded.cleanup() // org delete cascades the agent tasks
    resetErrorReporter?.()
    redisConn?.disconnect()
    producerConn?.disconnect()
  })

  test('cron schedules pass the expression and timezone through untouched', () => {
    assert.deepEqual(upsertOf('cron')?.repeat, { pattern: '*/5 * * * *', tz: 'America/New_York' })
  })

  test('hourly translates to top-of-hour and defaults the timezone to UTC', () => {
    assert.deepEqual(upsertOf('hourly')?.repeat, { pattern: '0 * * * *', tz: 'UTC' })
  })

  test('daily coerces HH:MM (leading zeros stripped) and keeps its timezone', () => {
    assert.deepEqual(upsertOf('daily')?.repeat, { pattern: '30 7 * * *', tz: 'Europe/London' })
  })

  test('weekly pins day-of-week to Monday (1) — the day is not configurable', () => {
    assert.deepEqual(upsertOf('weekly')?.repeat, { pattern: '5 18 * * 1', tz: 'UTC' })
  })

  test('missing time falls back to 09:00', () => {
    assert.deepEqual(upsertOf('dailyNoTime')?.repeat, { pattern: '0 9 * * *', tz: 'UTC' })
  })

  test('a colon-less time is treated as the hour with minute 0', () => {
    assert.deepEqual(upsertOf('dailySingleField')?.repeat, { pattern: '0 8 * * *', tz: 'UTC' })
  })

  test('KNOWN GAP: a non-numeric time yields a NaN cron pattern (only a real BullMQ upsert would reject it)', () => {
    // Documents current behavior, deliberately: Number('noon') is NaN and
    // repeatFor does not validate. In production the invalid pattern is only
    // caught because upsertJobScheduler throws and the registrar counts it as
    // `failed`. Do not "fix" this test without fixing repeatFor's validation.
    assert.deepEqual(upsertOf('dailyGarbageTime')?.repeat, { pattern: '0 NaN * * *', tz: 'UTC' })
  })

  test('cron type without an expression registers nothing', () => {
    assert.equal(upsertOf('cronMissingExpression'), undefined)
  })

  test('unknown schedule types register nothing', () => {
    assert.equal(upsertOf('unknownType'), undefined)
  })

  test('inactive schedules register nothing', () => {
    assert.equal(upsertOf('inactive'), undefined)
  })

  test('a non-object schedule is skipped data, not a crash', () => {
    assert.equal(upsertOf('notAnObject'), undefined)
  })

  test('the scheduler job template carries agent id, org, run-as user and objective', () => {
    const entry = upsertOf('cron')
    assert.equal(entry?.opts?.name, 'execute-scheduled-agent')
    assert.deepEqual(entry?.opts?.data, {
      agentId: agentIds.get('cron'),
      organizationId: seeded.organizationId,
      userId: seeded.userId,
      input: 'objective for cron',
    })
  })

  test('an owner-less agent runs as the org fallback member', () => {
    assert.equal(upsertOf('hourly')?.opts?.data?.userId, seeded.userId)
  })

  test('reconciliation reports registrations and no failures (stale removal saw an empty scheduler list)', () => {
    assert.equal(result.skipped, undefined)
    // >= because the shared QA DB may hold ACTIVE agents from other suites.
    assert.ok(result.registered >= 7, `registered ${result.registered}`)
    assert.equal(result.failed, 0)
    assert.equal(result.removed, 0)
  })

  test('when the Redis lock is held elsewhere the tick is skipped entirely', async () => {
    const realSet = redisConn.set
    redisConn.set = async () => null
    try {
      assert.deepEqual(await registerAgentSchedules(), { registered: 0, failed: 0, removed: 0, skipped: true })
    } finally {
      redisConn.set = realSet
    }
  })
}
