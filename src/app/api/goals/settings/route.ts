import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { mergeOrgSettings } from '@/lib/server/org-settings'

export const runtime = 'nodejs'

// settings:workspace, not member: laborHourlyRate/aiCostPerMTokensUsd are
// workspace-wide economics that every ROI figure the org sees is computed
// from — exactly the class the capability exists for. Any member being able
// to silently rewrite them (and, before the jsonb merge below, clobber every
// other key in the settings blob on the way) was a privilege-scoping bug.
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const input = z
    .object({
      laborHourlyRate: z.number().positive().max(10_000).optional(),
      aiCostPerMTokensUsd: z.number().positive().max(10_000).optional(),
    })
    .refine((body) => Object.keys(body).length > 0, { message: 'No settings supplied.' })
    .parse(await request.json().catch(() => ({})))
  // Atomic key-level merge — a concurrent save of unrelated settings keys
  // (retention toggles, customLimits, throttle claims) survives untouched.
  await mergeOrgSettings(auth.organizationId, input)
  return { success: true }
}, { requires: 'settings:workspace' })
