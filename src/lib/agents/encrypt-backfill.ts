import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { encryptionConfigured } from '@/lib/crypto/secrets'
import { encryptRunText, encryptRunValue } from './run-crypto'
import { Prisma } from '@/generated/prisma/client'

/**
 * Nightly encryption backfill for agent RUN DATA, mirroring the knowledge
 * substrate sweep. New writes are encrypted at rest (run-crypto.ts), but rows
 * written before this landed — or while ENCRYPTION_KEY was unset — still carry
 * plaintext. Retention bounds the exposure (transcript/plan pruned at 14 days,
 * rows deleted at 90), so this actively converges the LONGER-LIVED columns:
 * ExecutionMessage.content and AgentExecution.input/output.
 *
 * Un-encrypted rows are found cheaply by prefix: an encrypted value is a
 * ciphertext string ('v2:'/'v1:'/'b64:'), stored as a bare string in the Text
 * column and as a JSON string ('"v2:...') in the Json columns. Anything else is
 * legacy plaintext. Gated on a real key; bounded; per-row failures logged and
 * retried next night; never throws.
 */

const DEFAULT_CAP = 200

export type AgentBackfillResult = { messages: number; executions: number } | { skipped: string }

export async function encryptLegacyAgentRuns(db = systemPrisma, cap = DEFAULT_CAP): Promise<AgentBackfillResult> {
  if (!encryptionConfigured()) return { skipped: 'encryption-not-configured' }
  try {
    // systemPrisma: global encryption-hygiene sweep across all orgs, invoked
    // only from the CRON_SECRET-gated retention cron. Every write is id-keyed.
    const messageRows = await db.$queryRaw<Array<{ id: string; content: string }>>`
      SELECT id, content FROM execution_messages
      WHERE content <> '' AND content NOT LIKE 'v2:%' AND content NOT LIKE 'v1:%' AND content NOT LIKE 'b64:%'
      LIMIT ${cap}`
    let messages = 0
    for (const row of messageRows) {
      try {
        await db.executionMessage.update({ where: { id: row.id }, data: { content: encryptRunText(row.content) } })
        messages += 1
      } catch (error) {
        apiLogger.warn('encryptLegacyAgentRuns: message row failed; will retry', { messageId: row.id, error: error instanceof Error ? error.message : String(error) })
      }
    }

    const execRows = await db.$queryRaw<Array<{ id: string; input: unknown; output: unknown }>>`
      SELECT id, input, output FROM agent_executions
      WHERE (input::text NOT LIKE '"v2:%' AND input::text NOT LIKE '"v1:%' AND input::text NOT LIKE '"b64:%')
         OR (output IS NOT NULL AND output::text NOT LIKE '"v2:%' AND output::text NOT LIKE '"v1:%' AND output::text NOT LIKE '"b64:%')
      LIMIT ${cap}`
    let executions = 0
    for (const row of execRows) {
      try {
        await db.agentExecution.update({
          where: { id: row.id },
          data: {
            input: encryptRunValue(row.input),
            ...(row.output === null || row.output === undefined ? {} : { output: encryptRunValue(row.output) }),
          } as Prisma.AgentExecutionUpdateInput,
        })
        executions += 1
      } catch (error) {
        apiLogger.warn('encryptLegacyAgentRuns: execution row failed; will retry', { executionId: row.id, error: error instanceof Error ? error.message : String(error) })
      }
    }

    if (messageRows.length === cap || execRows.length === cap) {
      apiLogger.info('encryptLegacyAgentRuns: cap reached, more rows remain for the next sweep', { cap })
    }
    return { messages, executions }
  } catch (error) {
    apiLogger.warn('encryptLegacyAgentRuns failed', { error: error instanceof Error ? error.message : String(error) })
    return { skipped: 'error' }
  }
}
