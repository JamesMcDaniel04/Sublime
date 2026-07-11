/**
 * Register Sublime's signal receiver with People.ai SalesAI.
 *
 * POST /v1/salesai/webhooks (api.people.ai). Idempotent per the docs' event
 * set; called on org setup / first People.ai connect. Auth uses the org
 * service key (PAI-Client-*) since this is an account-level registration.
 *
 * SEAM: request/response shape follows the SalesAI API & Developer Guide;
 * adjust the body/headers here if the live contract differs.
 */

import { apiLogger } from '@/lib/logger'
import { SIGNAL_TYPES } from '@/lib/signals/map'

const SALESAI_BASE_URL = process.env.PEOPLE_AI_SALESAI_BASE_URL || 'https://api.people.ai'

export interface RegisterWebhookResult {
  registered: boolean
  reason?: string
}

export async function registerSalesAiWebhook(
  callbackUrl: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RegisterWebhookResult> {
  const clientId = process.env.PEOPLE_AI_SERVICE_CLIENT_ID
  const clientSecret = process.env.PEOPLE_AI_SERVICE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return { registered: false, reason: 'service credentials not configured' }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(`${SALESAI_BASE_URL}/v1/salesai/webhooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAI-Client-Id': clientId,
        'PAI-Client-Secret': clientSecret,
      },
      body: JSON.stringify({ url: callbackUrl, events: SIGNAL_TYPES }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      return { registered: false, reason: `status ${response.status}` }
    }
    return { registered: true }
  } catch (error) {
    apiLogger.warn('SalesAI webhook registration failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { registered: false, reason: 'request failed' }
  }
}
