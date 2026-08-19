/**
 * Every column that can hold a ciphertext. Listing the COLUMNS is unavoidable
 * (they are physical), but the rotation walk inside each is shape-based, so a
 * new secret FIELD within one of these blobs is covered automatically.
 *
 * A new secret-bearing COLUMN must be added here by hand —
 * rotate-coverage.test.ts derives the expected set from schema.prisma and
 * fails CI when this list drifts.
 */
export const ROTATION_TARGETS: ReadonlyArray<{ model: string; columns: string[] }> = [
  { model: 'credential', columns: ['authConfig'] },
  { model: 'mcpConnection', columns: ['authConfig'] },
  { model: 'postgresConnection', columns: ['authConfig'] },
  { model: 'integrationSecret', columns: ['authConfig'] },
  { model: 'googleOAuthConnection', columns: ['refreshTokenEnc'] },
  { model: 'slackWorkspaceConnection', columns: ['botToken', 'signingSecret'] },
  { model: 'knowledgeDocument', columns: ['contentEncrypted'] },
  { model: 'knowledgeChunk', columns: ['contentEncrypted'] },
  // Webhook trigger secrets ride inside the trigger/metadata blobs.
  { model: 'flow', columns: ['trigger'] },
  { model: 'flowVersion', columns: ['trigger'] },
  // Agent webhook trigger secrets live in AgentTask.metadata.triggerSecretEnc.
  { model: 'agentTask', columns: ['metadata'] },
  // Agent run data is encrypted IN PLACE (src/lib/agents/run-crypto.ts): the
  // Json columns hold a ciphertext string instead of the object, and the
  // content Text column holds a ciphertext string. The shape-based walk rotates
  // whichever of these is an encrypted string and leaves legacy plaintext alone.
  { model: 'agentExecution', columns: ['input', 'output', 'transcript', 'plan'] },
  { model: 'executionMessage', columns: ['content'] },
]
