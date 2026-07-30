import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToString } from 'react-dom/server'
import { PlanPicker } from '../plan-picker'

/**
 * The paywall is rendered by the (app) layout for EVERY member of an unpaid
 * workspace, not just admins — and /settings sits behind that same layout.
 *
 * So offering checkout links to a member is a dead end by construction: the
 * Stripe routes refuse them (billing:manage is admin-only), redirect to
 * /settings, and the layout answers with this same paywall. The member loops
 * with no explanation ever rendering. The only way out is to not offer the
 * link, and to say who can.
 */
test('the paywall offers checkout to an admin', () => {
  const html = renderToString(<PlanPicker canManageBilling />)
  assert.match(html, /\/api\/stripe\/checkout/)
})

test('the paywall never offers a member a checkout link they cannot use', () => {
  const html = renderToString(<PlanPicker canManageBilling={false} />)
  assert.doesNotMatch(
    html,
    /\/api\/stripe\/checkout/,
    'a member clicking this would be refused and bounced back to this same paywall',
  )
})

test('the paywall tells a member who can actually pay', () => {
  const html = renderToString(<PlanPicker canManageBilling={false} />)
  assert.match(html, /admin/i)
})
