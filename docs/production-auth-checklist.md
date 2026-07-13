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

The CSP currently permits inline scripts/styles for Next.js compatibility.
Move to request nonces and remove `unsafe-inline`/`unsafe-eval` after validating
all application and third-party scripts under the nonce-based policy.
