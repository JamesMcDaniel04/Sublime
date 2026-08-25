import type { QueueDriver, QueueMessage, MessageHandler } from '../driver'

/**
 * A broker that can be made to misbehave on demand.
 *
 * Every property the supervisor guarantees is about failure — a broker
 * restarting, a handler throwing, a shutdown mid-message — and none of those
 * can be provoked reliably against a real broker in a test.
 */
export class FakeQueueDriver implements QueueDriver {
  connectCount = 0
  closed = false
  acked: string[] = []
  nacked: string[] = []
  /** Fail this many connect attempts before succeeding. */
  failConnectTimes = 0
  onAck?: (id: string) => void

  private handler?: MessageHandler
  private onDisconnect?: () => void

  async connect(handler: MessageHandler, onDisconnect: () => void): Promise<void> {
    this.connectCount++
    if (this.failConnectTimes > 0) {
      this.failConnectTimes--
      throw new Error('the broker refused the connection')
    }
    this.handler = handler
    this.onDisconnect = onDisconnect
    this.closed = false
  }

  async ack(message: QueueMessage): Promise<void> {
    this.acked.push(message.id)
    this.onAck?.(message.id)
  }

  async nack(message: QueueMessage): Promise<void> {
    this.nacked.push(message.id)
  }

  async close(): Promise<void> {
    this.closed = true
    this.handler = undefined
  }

  /** Push a message as the broker would. */
  async deliver(message: QueueMessage): Promise<void> {
    await this.handler?.(message)
  }

  /** Simulate the broker going away. */
  async dropConnection(): Promise<void> {
    this.handler = undefined
    this.onDisconnect?.()
  }
}
