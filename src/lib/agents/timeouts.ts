export const AGENT_RUN_MAX_DURATION_SECONDS = 20 * 60
export const AGENT_RUN_TIMEOUT_MS = AGENT_RUN_MAX_DURATION_SECONDS * 1000

// Keep a single model turn below the enclosing 20 minute execution window so
// persistence/cleanup still has room to finish.
export const AGENT_MODEL_TURN_TIMEOUT_MS = 19 * 60 * 1000

// A run still `pending` this long never made it onto a worker (lost queue
// job). Deliberately generous — 3× the run window — so a merely backlogged
// queue is never misread as a lost job by the reaper. The pending reaper ALSO
// verifies the BullMQ job is actually gone before failing the row (a backlog
// deeper than this window is legitimate under load).
export const AGENT_PENDING_TIMEOUT_MS = 3 * AGENT_RUN_TIMEOUT_MS

// Reaper threshold for a 'running' row: strictly greater than the worst-case
// legitimate lifetime — lockDuration × (maxStalledCount + 1) covers one full
// stall-recovery replay after a worker crash — plus 5 minutes of cron jitter.
// At exactly AGENT_RUN_TIMEOUT_MS (the old value) the reaper raced BullMQ's
// stall recovery and failed runs that were actively resuming.
export const AGENT_STUCK_TIMEOUT_MS = 2 * AGENT_RUN_TIMEOUT_MS + 5 * 60 * 1000

