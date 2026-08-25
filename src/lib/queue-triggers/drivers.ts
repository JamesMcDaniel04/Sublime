import type { QueueBinding, QueueDriver, QueueMessage, MessageHandler } from './driver'

/**
 * The broker-specific half.
 *
 * Each driver is deliberately thin: connect, deliver, ack, close. Every
 * property that actually matters — ack ordering, backpressure, reconnection,
 * draining — belongs to the supervisor, so a driver cannot get them subtly
 * wrong in three different ways.
 *
 * Clients are imported lazily. The web runtime never opens a consumer, and
 * loading three broker libraries into a serverless bundle to support a feature
 * only the worker uses would be pure cost.
 */

/** A message body is JSON if it parses, and the raw text otherwise. */
function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // A broker carrying plain text or a protobuf blob is legitimate; refusing
    // it would make the trigger unusable for anything but JSON.
    return raw
  }
}

/**
 * RabbitMQ / AMQP 0-9-1.
 *
 * Consumes with manual acknowledgement (`noAck: false`) — the default in some
 * clients is to ack on delivery, which would lose every message the worker was
 * holding when it restarted.
 */
export class AmqpDriver implements QueueDriver {
  private connection?: { close(): Promise<void>; on(event: string, handler: () => void): void }
  private channel?: {
    ack(message: unknown): void
    nack(message: unknown, allUpTo: boolean, requeue: boolean): void
    consume(queue: string, handler: (message: unknown) => void, options: { noAck: boolean }): Promise<unknown>
    prefetch(count: number): Promise<void>
    close(): Promise<void>
  }

  constructor(private readonly binding: QueueBinding) {}

  async connect(handler: MessageHandler, onDisconnect: () => void): Promise<void> {
    const amqp = await import('amqplib')
    const connection = await amqp.connect(this.binding.url) as unknown as NonNullable<AmqpDriver['connection']>
    this.connection = connection

    // Both count as the broker going away; the supervisor reconnects.
    connection.on('close', onDisconnect)
    connection.on('error', onDisconnect)

    const channel = await (connection as unknown as { createChannel(): Promise<NonNullable<AmqpDriver['channel']>> }).createChannel()
    this.channel = channel

    // A second ceiling below the supervisor's: prefetch stops the BROKER from
    // pushing more than this, so backpressure holds even before our own
    // in-flight guard sees a message.
    await channel.prefetch(1)

    await channel.consume(this.binding.topic, (raw) => {
      if (!raw) return
      const message = raw as { content: Buffer; properties?: { messageId?: string }; fields?: { deliveryTag?: number } }
      void handler({
        // messageId when the publisher set one, else the delivery tag. The
        // publisher's id is preferable because it survives redelivery, which
        // is what makes downstream dedupe meaningful.
        id: message.properties?.messageId ?? String(message.fields?.deliveryTag ?? ''),
        body: parseBody(message.content.toString('utf8')),
        raw: message,
      })
    }, { noAck: false })
  }

  async ack(message: QueueMessage): Promise<void> {
    this.channel?.ack(message.raw)
  }

  async nack(message: QueueMessage): Promise<void> {
    // requeue: true — a failed message goes back for redelivery rather than
    // being discarded. A dead-letter policy is the broker's job to configure.
    this.channel?.nack(message.raw, false, true)
  }

  async close(): Promise<void> {
    await this.channel?.close().catch(() => undefined)
    await this.connection?.close().catch(() => undefined)
  }
}

/**
 * Kafka.
 *
 * Offsets are committed only for messages the supervisor acknowledged, via
 * `autoCommit: false`. Kafka's default commits on an interval regardless of
 * whether the work succeeded, which silently skips past anything that failed.
 */
export class KafkaDriver implements QueueDriver {
  private consumer?: {
    connect(): Promise<void>
    subscribe(options: { topic: string; fromBeginning: boolean }): Promise<void>
    run(options: { autoCommit: boolean; eachMessage: (payload: unknown) => Promise<void> }): Promise<void>
    commitOffsets(offsets: { topic: string; partition: number; offset: string }[]): Promise<void>
    disconnect(): Promise<void>
    on(event: string, handler: () => void): void
    events: Record<string, string>
  }

  constructor(private readonly binding: QueueBinding) {}

  async connect(handler: MessageHandler, onDisconnect: () => void): Promise<void> {
    const { Kafka } = await import('kafkajs')
    const kafka = new Kafka({
      clientId: 'sublime-worker',
      brokers: this.binding.url.split(',').map((broker) => broker.trim()).filter(Boolean),
    })
    const consumer = kafka.consumer({
      // A stable group id, so a restarted worker resumes where it stopped
      // rather than replaying the topic from the beginning.
      groupId: this.binding.group ?? `sublime-${this.binding.flowId}`,
    }) as unknown as NonNullable<KafkaDriver['consumer']>
    this.consumer = consumer

    await consumer.connect()
    consumer.on(consumer.events.CRASH, onDisconnect)
    consumer.on(consumer.events.DISCONNECT, onDisconnect)

    // fromBeginning: false — attaching a trigger to a busy topic must not
    // replay its entire history as new work.
    await consumer.subscribe({ topic: this.binding.topic, fromBeginning: false })

    await consumer.run({
      autoCommit: false,
      eachMessage: async (payload) => {
        const { topic, partition, message } = payload as {
          topic: string
          partition: number
          message: { offset: string; key?: Buffer | null; value: Buffer | null }
        }
        await handler({
          // Topic/partition/offset is Kafka's only globally unique identity.
          id: `${topic}:${partition}:${message.offset}`,
          body: parseBody(message.value?.toString('utf8') ?? ''),
          headers: message.key ? { key: message.key.toString('utf8') } : undefined,
          raw: { topic, partition, offset: message.offset },
        })
      },
    })
  }

  async ack(message: QueueMessage): Promise<void> {
    const position = message.raw as { topic: string; partition: number; offset: string }
    // Commit the NEXT offset: Kafka records where to resume, not what was read.
    await this.consumer?.commitOffsets([{
      topic: position.topic,
      partition: position.partition,
      offset: String(Number(position.offset) + 1),
    }])
  }

  async nack(): Promise<void> {
    // Nothing to do, and that is correct: an uncommitted offset is redelivered
    // when the group next resumes. Committing anything here would skip it.
  }

  async close(): Promise<void> {
    await this.consumer?.disconnect().catch(() => undefined)
  }
}

/**
 * MQTT.
 *
 * QoS 1, so the broker redelivers until acknowledged. QoS 0 is fire-and-forget
 * and would drop messages whenever the worker restarted.
 */
export class MqttDriver implements QueueDriver {
  private client?: {
    on(event: string, handler: (...args: unknown[]) => void): void
    subscribeAsync(topic: string, options: { qos: 0 | 1 | 2 }): Promise<unknown>
    endAsync(force?: boolean): Promise<void>
  }

  constructor(private readonly binding: QueueBinding) {}

  async connect(handler: MessageHandler, onDisconnect: () => void): Promise<void> {
    const mqtt = await import('mqtt')
    const client = await mqtt.connectAsync(this.binding.url, {
      // The library's own reconnect is off: the supervisor owns backoff, and
      // two independent reconnect loops fight each other.
      reconnectPeriod: 0,
      // manualConnack is not used; QoS 1 handles redelivery.
    }) as unknown as NonNullable<MqttDriver['client']>
    this.client = client

    client.on('close', onDisconnect)
    client.on('error', onDisconnect)

    await client.subscribeAsync(this.binding.topic, { qos: 1 })

    client.on('message', (...args: unknown[]) => {
      const [topic, payload, packet] = args as [string, Buffer, { messageId?: number }]
      void handler({
        id: packet?.messageId ? `${topic}:${packet.messageId}` : `${topic}:${Date.now()}`,
        body: parseBody(payload.toString('utf8')),
        headers: { topic },
      })
    })
  }

  async ack(): Promise<void> {
    // The client acknowledges QoS 1 delivery itself once the handler returns.
  }

  async nack(): Promise<void> {
    // Not acknowledging is the signal; the broker redelivers on reconnect.
  }

  async close(): Promise<void> {
    await this.client?.endAsync(true).catch(() => undefined)
  }
}

export function createQueueDriver(binding: QueueBinding): QueueDriver {
  switch (binding.broker) {
    case 'amqp': return new AmqpDriver(binding)
    case 'kafka': return new KafkaDriver(binding)
    case 'mqtt': return new MqttDriver(binding)
    default:
      throw new Error(`No consumer driver for broker "${binding.broker}".`)
  }
}
