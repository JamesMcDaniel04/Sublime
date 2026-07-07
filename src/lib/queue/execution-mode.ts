/**
 * Execution mode: `queue` runs agents on the BullMQ worker; `inline` runs them
 * inside the request. Production defaults to `queue` so signal bursts and long
 * multi-turn runs never execute on (or time out) the serverless request path —
 * set EXECUTION_MODE explicitly to override. Development defaults to `inline`
 * so a single `next dev` needs no worker/Redis.
 */
export function resolveExecutionMode(): 'inline' | 'queue' {
  const explicit = process.env.EXECUTION_MODE
  if (explicit === 'queue' || explicit === 'inline') return explicit
  return process.env.NODE_ENV === 'production' ? 'queue' : 'inline'
}

export const EXECUTION_MODE = resolveExecutionMode()
export const inlineExecution = EXECUTION_MODE !== 'queue'
