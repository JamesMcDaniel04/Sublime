/**
 * Stable BullMQ identity for a transactional-outbox dispatch. Both fresh and
 * resume jobs have one immutable outbox id; re-publishing after an ambiguous
 * queue response therefore deduplicates to the same BullMQ job.
 */
export type FlowQueueDecision = { jobId?: string; attempts?: number }

export function flowJobOptions(outboxId: string): FlowQueueDecision {
  return { jobId: `flow-${outboxId}`, attempts: 1 }
}
