import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { iceServersFromEnv } from '@/lib/rtc/ice'

export const runtime = 'nodejs'

/**
 * ICE servers for the voice huddle's WebRTC mesh. Credentials are minted per
 * request (time-limited in TURN_SHARED_SECRET mode), so clients fetch this at
 * huddle join rather than caching it. Authenticated users only — TURN relays
 * carry real bandwidth costs.
 */
export const GET = withAuthenticatedApi(async () => ({
  success: true,
  iceServers: iceServersFromEnv(
    {
      TURN_URLS: process.env.TURN_URLS,
      TURN_SHARED_SECRET: process.env.TURN_SHARED_SECRET,
      TURN_STATIC_USERNAME: process.env.TURN_STATIC_USERNAME,
      TURN_STATIC_CREDENTIAL: process.env.TURN_STATIC_CREDENTIAL,
    },
    Math.floor(Date.now() / 1000),
  ),
}))
