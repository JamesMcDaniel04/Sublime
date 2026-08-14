# Production authentication checklist

Repository controls are only half of the authentication boundary. Before a
production release, verify these settings in the Supabase Auth dashboard:

- Disable new-user signup unless self-service tenancy is intended. UI route
  hiding is not an authorization control.
- Keep `AUTH_ALLOW_JIT_PROVISIONING` unset for invitation/SSO-managed tenants.
- Require email confirmation and configure only the canonical application URL
  plus `/auth/callback` as allowed redirect destinations.
- Set a password minimum of 12 characters, enable leaked-password protection,
  and configure CAPTCHA on signup and password recovery.
- Enable refresh-token reuse detection, short access-token expiry, and SMTP
  with SPF, DKIM, and DMARC for the application domain.
- Enable TOTP MFA and require AAL2 for organizations whose policy mandates MFA.
- Configure SSO providers with exact callback URLs and restrict tenant/domain
  assignment at the identity provider and application provisioning layer.
- Configure globally shared Redis/Upstash rate limiting for public webhooks and
  verify Supabase Auth rate limits for password, OTP, recovery, and signup.
- Set `NEXT_PUBLIC_APP_URL` to the canonical HTTPS origin. Never use a preview
  or localhost URL in production email links.
- Confirm TLS termination preserves HSTS and does not weaken the CSP or other
  security headers emitted by the application.
- Test signup-disabled, recovery, email change, MFA enrollment/challenge,
  suspension, logout-all-sessions, and expired-link behavior before release.

Run `npm run check:auth` to verify the settings above that are machine-checkable.
It reports signup and email-confirmation state from the anon key alone, and
CAPTCHA, leaked-password protection, password length and the auth rate limits
when `SUPABASE_ACCESS_TOKEN` is set. It exits 0 when it cannot run, so it is
safe anywhere.

Enable Turnstile in **both** places or it protects nothing: the Supabase Auth
dashboard (signup, login and recovery go browser → Supabase, so only Supabase
can verify those tokens) and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` /
`TURNSTILE_SECRET_KEY` here. `check:auth` fails specifically on the mismatch
where our keys are set but Supabase's CAPTCHA is off, because that combination
renders a challenge nobody verifies.

Set `UPLOAD_SCANNER_URL` in any deployment that accepts files from untrusted
users. Uploaded bytes reach `pdf-parse` and `mammoth` in-process.

## Content-Security-Policy status

`src/lib/security/csp.ts` uses a per-request nonce for scripts; `unsafe-eval` is
development-only and `unsafe-inline` is not present in `script-src`. Violations
report to `/api/security/csp-report`.

What genuinely remains is `style-src 'unsafe-inline'`, which Next's inline style
injection still requires during dynamic rendering. Removing it needs a
styled-nonce audit of every component and belongs in its own change.

Note that the CSP is load-bearing rather than defence-in-depth here: the
Supabase session cookie cannot be `httpOnly`, because `@supabase/ssr` shares one
cookie with `createBrowserClient`, which reads it from `document.cookie`. The
CSP is what carries that exposure. See `SESSION_COOKIE_OPTIONS` in
`src/lib/supabase/config.ts`.
