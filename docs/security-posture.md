# Security posture

The 20-item checklist audited on 2026-08-13, with the control, the file that
implements it, and the test that keeps it true. The point of the third column is
that the next audit should be a diff, not a rediscovery — an item with no test
is a claim, not a control.

Implementation plan: `docs/superpowers/plans/2026-08-13-security-gap-closure.md`.

| # | Item | Control | Implemented in | Guarded by |
|---|---|---|---|---|
| 1 | Hide API keys | Four `NEXT_PUBLIC_*` vars, all legitimately public; no server secret read in any `'use client'` file | `src/lib/env.ts` | — (see Open items) |
| 2 | Purge Git secrets | gitleaks over full history, allow-listed by exact fixture value | `.gitleaks.toml` | CI `security` job |
| 3 | Use public DB key | Anon key client-side; service role only server-side | `src/lib/supabase/{client,admin}.ts` | — |
| 4 | Enable RLS | `anon`/`authenticated` revoked from all public tables + default privileges disarmed | `prisma/migrations/20260813210000_lock_public_schema_grants` | `src/lib/__tests__/public-schema-grants.pg.test.ts` |
| 5 | Encrypt sensitive data | AES-256-GCM, HKDF + per-secret salt (v2), pinned auth tag length | `src/lib/crypto/secrets.ts` | `src/lib/crypto/__tests__/{secrets,rotate}.test.ts` |
| 6 | Enforce server-side auth | `withAuthenticatedApi` with a mandatory `requires` | `src/lib/server/api-handler.ts` | `src/app/api/__tests__/route-permissions.test.ts` |
| 7 | Lock record access | Prisma extension rejects org-model queries without `organizationId` | `src/lib/tenant-guard.ts` | `src/app/api/__tests__/rbac-e2e.test.ts` |
| 8 | Block field tampering | Zod allowlists; no mass assignment | per route | `src/app/api/__tests__/mutation-route-contract.test.ts` |
| 9 | Secure session cookies | `path`/`sameSite`/`secure` pinned, not inherited | `src/lib/supabase/config.ts` | `src/lib/supabase/__tests__/cookie-options.test.ts` |
| 10 | Hash passwords | Delegated — no password column exists | Supabase Auth | `npm run check:auth` |
| 11 | Rate limit login | Turnstile in front of Supabase auth; app routes rate-limited per user and per org | `src/lib/{ratelimit,security/turnstile}.ts` | `npm run check:auth` |
| 12 | Add bot protection | Turnstile on login, signup, recovery and `/api/contact` | `src/lib/security/turnstile.ts` | `src/lib/security/__tests__/turnstile.test.ts` |
| 13 | Parameterize queries | Prisma throughout; `$queryRawUnsafe` call sites use `$1` placeholders | — | CI `security` job (semgrep) |
| 14 | Validate all input | Zod on every body-reading route; 1 MB default body cap | `src/lib/server/api-handler.ts` | `src/lib/server/__tests__/body-limit.test.ts` |
| 15 | Escape user content | React escaping; no `rehype-raw`; **zero** `dangerouslySetInnerHTML` | `src/app/(app)/settings/tabs/security.tsx` | CI `security` job (semgrep) |
| 16 | Restrict file uploads | Magic-byte match, 10 MB cap, zip-bomb budget, pluggable AV | `src/lib/security/{file-signature,scan-upload}.ts` | `src/lib/security/__tests__/*.test.ts` |
| 17 | Trim API responses | Explicit `select` in 86 route files; redaction helpers | per route | `src/app/api/__tests__/credentials-route-smoke.test.ts` |
| 18 | Add security headers | Nonce CSP + HSTS + COOP + frame-deny, violations reported | `next.config.js`, `src/lib/security/csp.ts` | `src/lib/security/__tests__/csp.test.ts` |
| 19 | Force HTTPS | HSTS preload, `upgrade-insecure-requests`, https-only SSRF guard | `next.config.js`, `src/lib/net/ssrf.ts` | `src/lib/net/__tests__/` |
| 20 | Scan dependencies | Blocking `audit:prod`, nightly sweep, Dependabot with 7-day cooldown | `.github/{workflows/ci.yml,dependabot.yml}` | CI `vulnerabilities` job |

## Baselines as of 2026-08-13

- `npm audit` (production and full): **0 vulnerabilities**.
- gitleaks 8.30.1 over 1309 commits: **0 findings** after allow-listing 8
  fixtures and prose false positives.
- semgrep 1.173.0 `p/default --severity=ERROR`: **4 findings**, of which 2 were
  real (`gcm-no-tag-length`, now fixed) and 2 are the same known-fake fixtures
  gitleaks flags. Semgrep is informational in CI until this reaches zero; flip
  `continue-on-error` off in the `security` job at that point.
- Grant lockdown, measured on a throwaway Postgres with Supabase's stock
  default privileges armed: **71/71 tables anon-readable before, 0/71 after**.

## Open items

Deliberately not closed, with the reason:

- **Full RLS on the ~60 application models.** Postgres exempts a table's owner
  from RLS and Prisma connects as the owner, so enabling it changes nothing
  until the app connects as a non-owner role with a per-request tenant context —
  which is non-trivial under PgBouncer transaction pooling. The grant revoke
  removes the exposure that mattered. Path documented in
  `docs/runbooks/verify-postgrest-exposure.md`.
- **`style-src 'unsafe-inline'`.** Next injects inline styles during dynamic
  rendering. Removing it needs a styled-nonce audit of every component.
- **A CI guard against a future `NEXT_PUBLIC_` secret.** Today this is verified
  by inspection. A test asserting that no `'use client'` file reads a non-public
  env var would make item 1 structural rather than reviewed.
- **Proxying Supabase auth through the app** so login falls under the app's own
  rate limiter. Large and risky, and largely redundant now that Turnstile sits
  in front of the same forms.
- **Production verification of the grant revoke.** The migration is proven on a
  simulated Supabase; run the query in
  `docs/runbooks/verify-postgrest-exposure.md` against production to confirm the
  starting state and the result.
