# Production authentication checklist

Repository controls are only half of the authentication boundary. Before a
production release, verify these settings in the Supabase Auth dashboard:

- Disable new-user signup unless self-service tenancy is intended. UI route
  hiding is not an authorization control.
- Verify every successful self-service signup receives its own organization;
  pending invitations must join the invited organization instead. To run an
  invitation/SSO-only tenant, disable signup in Supabase and set
  `AUTH_ALLOW_PASSWORD=false` rather than allowing an org-less identity.
- Set `SUPABASE_SERVICE_ROLE_KEY` in the production server environment. It is
  required for workspace invitations, member removal, account deletion, and
  global session revocation; never expose it through a `NEXT_PUBLIC_*` value.
- Apply all Prisma migrations during the production deploy and verify that the
  `organization_invitations` table exists before testing invitations.
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
- Add the canonical `https://<app-host>/auth/callback` URL to Supabase Auth's
  redirect allow-list, and configure the same canonical host as the Site URL.
- Confirm TLS termination preserves HSTS and does not weaken the CSP or other
  security headers emitted by the application.
- Test signup-disabled, a new invitation, invitation resend/revoke, expired
  links, recovery, email change, MFA enrollment/challenge, member role changes,
  suspension/removal, and logout-all-sessions before release.

The CSP currently permits inline scripts/styles for Next.js compatibility.
Move to request nonces and remove `unsafe-inline`/`unsafe-eval` after validating
all application and third-party scripts under the nonce-based policy.
