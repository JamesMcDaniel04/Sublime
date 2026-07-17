/**
 * ICE server configuration for the Flow Jam voice huddle (closes audit gap H1).
 *
 * STUN alone cannot connect symmetric-NAT / corporate-VPN pairs — those need a
 * TURN relay. TURN is deployment-provided via env, in either mode:
 *
 *   TURN_URLS                 comma-separated (turn:host:3478, turns:host:5349)
 *   TURN_SHARED_SECRET        coturn `use-auth-secret` mode — we mint
 *                             time-limited credentials per request (username is
 *                             the unix expiry, credential is HMAC-SHA1 of it)
 *   TURN_STATIC_USERNAME /    long-lived credentials, for providers that issue
 *   TURN_STATIC_CREDENTIAL    fixed accounts
 *
 * No TURN env → STUN-only, exactly today's behaviour. The credential TTL keeps
 * a leaked ICE response useful for hours, not forever.
 */
import { createHmac } from 'crypto'

export type IceServerEntry = { urls: string[]; username?: string; credential?: string }

export const DEFAULT_STUN_SERVERS: IceServerEntry[] = [
  { urls: ['stun:stun.l.google.com:19302'] },
  { urls: ['stun:stun1.l.google.com:19302'] },
]

export const TURN_CREDENTIAL_TTL_SECONDS = 2 * 60 * 60

type TurnEnv = {
  TURN_URLS?: string
  TURN_SHARED_SECRET?: string
  TURN_STATIC_USERNAME?: string
  TURN_STATIC_CREDENTIAL?: string
}

export function iceServersFromEnv(env: TurnEnv, nowSeconds: number): IceServerEntry[] {
  const urls = (env.TURN_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  if (!urls.length) return DEFAULT_STUN_SERVERS
  if (env.TURN_SHARED_SECRET) {
    const username = String(nowSeconds + TURN_CREDENTIAL_TTL_SECONDS)
    const credential = createHmac('sha1', env.TURN_SHARED_SECRET).update(username).digest('base64')
    return [...DEFAULT_STUN_SERVERS, { urls, username, credential }]
  }
  if (env.TURN_STATIC_USERNAME && env.TURN_STATIC_CREDENTIAL) {
    return [...DEFAULT_STUN_SERVERS, { urls, username: env.TURN_STATIC_USERNAME, credential: env.TURN_STATIC_CREDENTIAL }]
  }
  return DEFAULT_STUN_SERVERS
}
