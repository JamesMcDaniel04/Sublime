import type { QueueBinding, QueueDriver, QueueMessage } from './driver'

/**
 * Supervises long-lived broker consumers.
 *
 * A consumer is not a request. It is a connection that must survive the broker
 * restarting, must not acknowledge a message before the work is safe, must not
 * read faster than it can process, and must drain rather than drop on
 * shutdown. Those four properties are what this class owns, once, for every
 * broker — which is why the driver interface is as small as it is.
 */

export interface SupervisorOptions {
  createDriver: (binding: QueueBinding) => QueueDriver
  /** Runs per message. Throwing means "not handled" and the message is nacked. */
  onMessage: (message: QueueMessage, binding: QueueBinding) => Promise<void>
  /**
   * How long to wait before retry N.
   *
   * Exponential with a ceiling by default: a broker that is down must not be
   * hammered in a tight loop, which is a self-inflicted denial of service on
   * someone else's infrastructure — and the thing most likely to keep it down.
   */
  backoffMs?: (attempt: number) => number
  /**
   * Messages handled concurrently per binding.
   *
   * Without a ceiling a backlog of 100k messages is read into memory as fast
   * as the broker will serve it, and the worker dies — taking every other
   * queue and every in-flight flow run with it.
   */
  maxInFlight?: number
}

const DEFAULT_BACKOFF = (attempt: number) => Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))

interface Consumer {
  binding: QueueBinding
  driver: QueueDriver
  attempt: number
  inFlight: Set<Promise<void>>
  stopped: boolean
  timer?: NodeJS.Timeout
}

export class ConsumerSupervisor {
  private readonly consumers = new Map<string, Consumer>()
  private running = false

  constructor(private readonly options: SupervisorOptions) {}

  private get backoff() { return this.options.backoffMs ?? DEFAULT_BACKOFF }
  private get maxInFlight() { return this.options.maxInFlight ?? 10 }

  /**
   * Bring up a consumer per binding.
   *
   * Idempotent: a binding already running is left alone rather than
   * double-subscribed, so a periodic reconcile can call this safely.
   */
  async start(bindings: QueueBinding[]): Promise<void> {
    this.running = true
    await Promise.all(
      bindings
        .filter((binding) => !this.consumers.has(binding.id))
        .map((binding) => this.open(binding)),
    )
  }

  private async open(binding: QueueBinding): Promise<void> {
    const consumer: Consumer = {
      binding,
      driver: this.options.createDriver(binding),
      attempt: 0,
      inFlight: new Set(),
      stopped: false,
    }
    this.consumers.set(binding.id, consumer)
    await this.connect(consumer)
  }

  private async connect(consumer: Consumer): Promise<void> {
    if (!this.running || consumer.stopped) return
    try {
      await consumer.driver.connect(
        (message) => this.handle(consumer, message),
        () => this.scheduleReconnect(consumer),
      )
      // Only a working connection resets the backoff. Resetting on the attempt
      // itself would turn a broker that accepts then immediately drops into
      // exactly the tight loop the backoff exists to prevent.
      consumer.attempt = 0
    } catch {
      // A binding that cannot connect must not take down the others, so this
      // is contained here rather than propagated out of start().
      this.scheduleReconnect(consumer)
    }
  }

  private scheduleReconnect(consumer: Consumer): void {
    if (!this.running || consumer.stopped) return
    const delay = this.backoff(consumer.attempt++)
    consumer.timer = setTimeout(() => { void this.connect(consumer) }, delay)
    // A pending reconnect must not hold the process open by itself.
    consumer.timer.unref?.()
  }

  /**
   * Handle one message.
   *
   * Ack strictly AFTER the handler resolves. Acknowledging first means a crash
   * between the ack and the work loses the message with no record it existed —
   * the broker believes it was delivered and nothing else knows about it.
   *
   * A throw nacks instead, so the broker can redeliver. That makes delivery
   * at-least-once, which is why the flow side dedupes on the message id.
   */
  private async handle(consumer: Consumer, message: QueueMessage): Promise<void> {
    if (!this.running || consumer.stopped) return

    // Backpressure: wait for a slot rather than reading ahead. Awaiting here
    // is what actually slows the broker down, since most clients stop
    // delivering while a delivery is outstanding.
    while (consumer.inFlight.size >= this.maxInFlight) {
      await Promise.race(consumer.inFlight)
    }

    const work = (async () => {
      try {
        await this.options.onMessage(message, consumer.binding)
        await consumer.driver.ack(message)
      } catch {
        // Nacking can itself fail on a dead connection; that is survivable and
        // must not escape into the driver's delivery loop, which would usually
        // tear down the consumer.
        try { await consumer.driver.nack(message) } catch { /* connection is gone */ }
      }
    })()

    consumer.inFlight.add(work)
    try {
      await work
    } finally {
      consumer.inFlight.delete(work)
    }
  }

  /**
   * Stop every consumer, draining in-flight work first.
   *
   * A worker redeploys constantly. Dropping in-flight messages on each deploy
   * would make queue triggers unreliable by design — and those messages are
   * already un-acked, so they would be redelivered and reprocessed.
   */
  async stop(): Promise<void> {
    this.running = false
    await Promise.all([...this.consumers.values()].map(async (consumer) => {
      consumer.stopped = true
      if (consumer.timer) clearTimeout(consumer.timer)
      // Drain BEFORE closing: closing first would drop the connection the
      // pending acks need.
      await Promise.allSettled([...consumer.inFlight])
      await consumer.driver.close().catch(() => undefined)
    }))
    this.consumers.clear()
  }
}
