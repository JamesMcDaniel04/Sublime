import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { readShellSnapshot } from '@/lib/server/snapshot'

export const runtime = 'nodejs'

/**
 * GET /api/snapshot — everything the app shell polls, in ONE request.
 *
 * The dashboard, sidebar, and notification bell used to poll five separate
 * endpoints (/agents, /agents/activity, /usage, /organizations,
 * /notifications), each paying its own auth + function invocation — ~6
 * authenticated requests per user per poll cycle. This endpoint answers them
 * with a single auth and a compact parallel read model, so the app shell
 * costs one request per cycle regardless of how many widgets poll.
 *
 * Agent run history is intentionally excluded; Agent HQ fetches only the
 * selected agent's activity through /api/agents/activity.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => readShellSnapshot(auth))
