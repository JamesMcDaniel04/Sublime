import type { AssistantChatMessage } from '@prisma/client'

/**
 * Shared helpers for the Home assistant chat routes (`/chat` and
 * `/chat/sessions`).
 */

/** A conversation title derived from the first user message. */
export function deriveTitle(message: string): string {
  const text = message.trim().replace(/\s+/g, ' ')
  if (!text) return 'New chat'
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

export function serializeMessage(message: AssistantChatMessage) {
  const metadata =
    message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : {}
  const attachment =
    metadata.attachment && typeof metadata.attachment === 'object'
      ? (metadata.attachment as { filename?: string; truncated?: boolean })
      : null
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    // The stored attachment carries the full extracted text (for follow-up
    // turns); the wire shape only needs the chip.
    attachment: attachment
      ? { filename: attachment.filename ?? 'attachment', truncated: Boolean(attachment.truncated) }
      : null,
    createdAgent: metadata.createdAgent ?? null,
    executedRun: metadata.executedRun ?? null,
    action: metadata.action ?? null,
  }
}
