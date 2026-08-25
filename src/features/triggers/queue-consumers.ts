import { systemPrisma } from '@/lib/prisma'
import { takeUnseen } from '@/features/flows/static-store'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { ConsumerSupervisor } from '@/lib/queue-triggers/supervisor'
import { createQueueDriver } from '@/lib/queue-triggers/drivers'
import type { QueueBinding, QueueBroker, QueueMessage } from '@/lib/queue-triggers/driver'

/**
 * Queue triggers, wired to real flows.
 *
 * The supervisor owns connection lifecycle; this owns the two things that are
 * about US rather than about brokers: which flows want messages, and making a
 * redelivered message not run the flow twice.
 *
 * Every broker here is at-least-once by design — that is what makes them
 * durable — so duplicates are expected rather than exceptional, and dedupe is
 * a correctness requirement rather than a nicety.
 */

const BROKERS = new Set<QueueBroker>(['amqp', 'kafka', 'mqtt'])

interface QueueTriggerConfig {
  broker?: unknown
  url?: unknown
  topic?: unknown
  group?: unknown
}

/**
 * The queue bindings this workspace has published.
 *
 * PUBLISHED flows only, and only ACTIVE ones. A draft consuming from a live
 * broker would run unreviewed logic against production messages, and those
 * messages are consumed — there is no re-reading them once a draft has eaten
 * them.
 */
export async function queueBindings(): Promise<QueueBinding[]> {
  // systemPrisma with justification: this is a WORKER-WIDE reconcile that
  // must see every workspace's queue-triggered flows to open their consumers.
  // There is no caller and therefore no organization to scope by — the tenant
  // guard is right to demand one, and this is the legitimate exception it
  // describes. Each binding carries its own organizationId forward, so every
  // run dispatched from a message is scoped normally.
  const flows = await systemPrisma.flow.findMany({
    where: { status: 'ACTIVE', publishedGraph: { not: undefined } },
    select: { id: true, organizationId: true, userId: true, trigger: true, publishedGraph: true },
  })

  const bindings: QueueBinding[] = []
  for (const flow of flows) {
    const trigger = (flow.trigger ?? {}) as { type?: unknown } & QueueTriggerConfig
    if (trigger.type !== 'queue') continue
    if (!flow.publishedGraph) continue

    const broker = String(trigger.broker ?? '') as QueueBroker
    const url = String(trigger.url ?? '').trim()
    const topic = String(trigger.topic ?? '').trim()
    // Anything incomplete is skipped rather than half-connected: a consumer
    // that attaches to the wrong topic silently eats someone else's messages.
    if (!BROKERS.has(broker) || !url || !topic) continue
    // A flow with no owner has nobody to attribute the run to. Skipping is
    // right: the alternative is a run with a null actor that no permission
    // check can reason about.
    if (!flow.userId) continue

    bindings.push({
      id: flow.id,
      flowId: flow.id,
      organizationId: flow.organizationId,
      userId: flow.userId,
      broker,
      url,
      topic,
      ...(typeof trigger.group === 'string' && trigger.group ? { group: trigger.group } : {}),
    })
  }
  return bindings
}

/**
 * Run a flow for one message.
 *
 * Deduped through the same cross-run store the email trigger and the dedupe
 * node use, which claims ids in a transaction with SELECT … FOR UPDATE. Two
 * workers consuming the same queue therefore cannot both run the flow for one
 * message.
 *
 * A message seen before is silently accepted — returning normally is what
 * makes the supervisor ACK it. Throwing would nack it back to the broker and
 * produce an infinite redelivery loop for a message we have already handled.
 */
export async function runFlowForMessage(message: QueueMessage, binding: QueueBinding): Promise<void> {
  const { fresh } = await takeUnseen(
    binding.organizationId,
    binding.flowId,
    [{ id: message.id }],
    'id',
  )
  if (fresh.length === 0) return

  await dispatchFlowExecution({
    flowId: binding.flowId,
    organizationId: binding.organizationId,
    userId: binding.userId,
    input: message.body,
    trigger: { type: 'queue', broker: binding.broker, topic: binding.topic, messageId: message.id },
    idempotencyKey: `queue:${binding.flowId}:${message.id}`,
  } as never, { background: true })
}

/**
 * The worker's queue-consumer supervisor.
 *
 * One instance per process. `reconcile` is safe to call repeatedly — the
 * supervisor leaves already-running bindings alone — so a flow published or
 * unpublished mid-life is picked up without a restart.
 */
export class QueueTriggerService {
  private readonly supervisor = new ConsumerSupervisor({
    createDriver: createQueueDriver,
    onMessage: runFlowForMessage,
  })

  async reconcile(): Promise<number> {
    const bindings = await queueBindings()
    await this.supervisor.start(bindings)
    return bindings.length
  }

  async stop(): Promise<void> {
    await this.supervisor.stop()
  }
}
