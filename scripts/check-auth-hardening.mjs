#!/usr/bin/env node
/**
 * Report whether the Supabase Auth project is actually hardened.
 *
 * docs/production-auth-checklist.md lists a dozen dashboard settings that no
 * amount of application code can enforce — signup disabled, CAPTCHA on, leaked
 * password protection, auth rate limits. The audit's finding was not that they
 * were wrong, but that NOBODY COULD TELL: the checklist was unverifiable prose,
 * and login/signup/recovery never touch our rate limiter because they go
 * browser -> Supabase directly.
 *
 * This makes them checkable. Two tiers, because they need different credentials:
 *
 *   1. The public settings endpoint (needs only the anon key we already have)
 *      reports signup and email-confirmation state.
 *   2. The Management API (needs SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF,
 *      a personal access token from supabase.com/dashboard/account/tokens)
 *      reports CAPTCHA, leaked-password protection, password length and the
 *      auth rate limits.
 *
 * Exits non-zero when a check fails, 0 when it merely cannot run — so it is
 * safe in CI and on a developer machine with no credentials.
 *
 * Usage:  npm run check:auth
 */

const RESET = '[0m'
const RED = '[31m'
const GREEN = '[32m'
const YELLOW = '[33m'
const DIM = '[2m'

let failures = 0
let skipped = 0

function pass(label, detail) {
  console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${DIM}(${detail})${RESET}` : ''}`)
}
function fail(label, detail) {
  failures += 1
  console.log(`  ${RED}✗${RESET} ${label}${detail ? ` ${DIM}(${detail})${RESET}` : ''}`)
}
function unknown(label, detail) {
  skipped += 1
  console.log(`  ${YELLOW}?${RESET} ${label}${detail ? ` ${DIM}(${detail})${RESET}` : ''}`)
}

/** Assert a boolean setting, tolerating an API that does not report it. */
function expectBool(config, key, wanted, label) {
  if (!(key in config)) return unknown(label, `${key} not reported by this API version`)
  const actual = config[key] === true
  if (actual === wanted) pass(label, `${key}=${config[key]}`)
  else fail(label, `${key}=${config[key]}, expected ${wanted}`)
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '')
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  console.log('\nSupabase Auth hardening\n')

  if (!url || !anonKey) {
    console.log(
      `  ${YELLOW}cannot verify${RESET} — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.\n`,
    )
    console.log(`  ${DIM}Pull them with: vercel env pull${RESET}\n`)
    return 0
  }

  // ── Tier 1: public settings ──────────────────────────────────────────────
  console.log(`${DIM}Public settings (${url})${RESET}`)
  let settings
  try {
    const response = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: anonKey },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      fail('reach /auth/v1/settings', `HTTP ${response.status}`)
      return 1
    }
    settings = await response.json()
  } catch (error) {
    fail('reach /auth/v1/settings', error instanceof Error ? error.message : String(error))
    return 1
  }

  // Password signup disabled is the invite/SSO-only posture the checklist asks
  // for. AUTH_ALLOW_PASSWORD=false hides the UI route; only this disables the
  // API, and route hiding is not an authorization control.
  expectBool(settings, 'disable_signup', true, 'password signup is disabled')
  // Auto-confirm on would let anyone register an address they do not own.
  expectBool(settings, 'mailer_autoconfirm', false, 'email confirmation is required')

  // ── Tier 2: management API ───────────────────────────────────────────────
  const token = process.env.SUPABASE_ACCESS_TOKEN
  const ref = process.env.SUPABASE_PROJECT_REF || url.match(/https:\/\/([^.]+)\.supabase\./)?.[1]

  console.log(`\n${DIM}Auth configuration${RESET}`)
  if (!token || !ref) {
    unknown(
      'CAPTCHA, leaked-password protection, password length, auth rate limits',
      'set SUPABASE_ACCESS_TOKEN (supabase.com/dashboard/account/tokens) to check these',
    )
  } else {
    let config
    try {
      const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        fail('read auth config', `HTTP ${response.status} — is the token valid for project ${ref}?`)
        config = null
      } else {
        config = await response.json()
      }
    } catch (error) {
      fail('read auth config', error instanceof Error ? error.message : String(error))
      config = null
    }

    if (config) {
      expectBool(config, 'security_captcha_enabled', true, 'CAPTCHA is enabled on auth endpoints')
      expectBool(config, 'security_manual_linking_enabled', false, 'manual identity linking is off')
      expectBool(config, 'password_hibp_enabled', true, 'leaked-password protection is on')
      expectBool(config, 'mfa_totp_enroll_enabled', true, 'TOTP MFA enrollment is available')

      if ('password_min_length' in config) {
        const min = Number(config.password_min_length)
        if (min >= 12) pass('password minimum is >= 12', `${min}`)
        else fail('password minimum is >= 12', `${min}`)
      } else {
        unknown('password minimum is >= 12', 'password_min_length not reported')
      }

      // Any auth rate limit at its stock value is worth a look — these are the
      // only throttle on credential stuffing, since the app never sees these
      // requests. Reported rather than asserted: the right number is a
      // deployment decision, but an unexamined default is not.
      const limits = Object.entries(config).filter(([key]) => key.startsWith('rate_limit_'))
      if (limits.length) {
        console.log(`\n${DIM}Auth rate limits (per hour unless noted)${RESET}`)
        for (const [key, value] of limits) console.log(`  ${DIM}·${RESET} ${key} = ${value}`)
      }

      // The one cross-check worth making automatically: our own Turnstile keys
      // being set while Supabase's CAPTCHA is off means the widget renders,
      // the user solves it, and nothing verifies the token on the auth path.
      if (process.env.TURNSTILE_SECRET_KEY && config.security_captcha_enabled === false) {
        console.log('')
        fail(
          'Turnstile is configured here but CAPTCHA is OFF in Supabase',
          'auth pages render a challenge nobody verifies — enable it in Authentication → Settings',
        )
      }
    }
  }

  console.log('')
  if (failures) {
    console.log(`${RED}${failures} check(s) failed.${RESET} See docs/production-auth-checklist.md.\n`)
    return 1
  }
  if (skipped) {
    console.log(`${YELLOW}${skipped} check(s) could not run.${RESET} Everything verifiable passed.\n`)
    return 0
  }
  console.log(`${GREEN}All checks passed.${RESET}\n`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
