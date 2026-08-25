/**
 * What the supervisor needs from a broker, and nothing more.
 *
 * Deliberately tiny. Kafka, AMQP and MQTT disagree about almost everything —
 * consumer groups versus queues versus topics, offsets versus delivery tags,
 * at-least-once versus at-most-once defaults — but they agree on this much:
 * something delivers messages, the consumer says whether each one was handled,
 * and the connection can go away.
 *
 * Keeping the interface at that level is what lets the supervisor own every
 * property that actually matters (ordering of ack, backpressure, reconnection,
 * draining) once, rather than each driver reimplementing them differently.
 */

export type QueueBroker = 'amqp' | 'kafka' | 'mqtt' | 'fake'

export interface QueueBinding {
  id: string
  flowId: string
  organizationId: string
  userId: string
  broker: QueueBroker
  /** Broker connection string. Operator configuration, not user input. */
  url: string
  /** Queue, topic, or subject, depending on the broker. */
  topic: string
  /** Kafka consumer group / AMQP consumer tag. Absent uses a derived default. */
  group?: string
}

export interface QueueMessage {
  /** Stable per delivery — the dedupe identity and the ack handle. */
  id: string
  body: unknown
  headers?: Record<string, string>
  /** Driver-private handle (delivery tag, offset, packet id). */
  raw?: unknown
}

export type MessageHandler = (message: QueueMessage) => Promise<void>

export interface QueueDriver {
  /**
   * Open the connection and begin delivering.
   *
   * `onDisconnect` is how a driver reports that the broker went away without
   * the consumer asking — the supervisor turns that into a reconnect.
   */
  connect(handler: MessageHandler, onDisconnect: () => void): Promise<void>
  ack(message: QueueMessage): Promise<void>
  nack(message: QueueMessage): Promise<void>
  close(): Promise<void>
}
