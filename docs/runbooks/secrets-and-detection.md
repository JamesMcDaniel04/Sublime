# Secrets, detection & MFA runbook

Operational levers for the security controls closed in the 2026-08-19 gap pass.
Everything here is an **operator/infra action** — the code ships the mechanism;
these are the knobs and the break-glass.

## Encryption key rotation (now a rolling operation)

Runtime decryption falls back to `OLD_ENCRYPTION_KEY`, so rotation no longer
needs a maintenance window.

1. Generate a new key: `openssl rand -hex 32`.
2. Deploy with **both** set: `ENCRYPTION_KEY=<new>`, `OLD_ENCRYPTION_KEY=<current>`.
   The app now writes under the new key and reads under either.
3. Re-encrypt existing rows: `npx tsx scripts/rotate-encryption-key.ts --apply`
   (dry-run without `--apply`; `--report` for a plaintext/ciphertext census).
   Idempotent and resumable; never destroys unreadable values.
4. When the report shows zero rows under the old key, remove `OLD_ENCRYPTION_KEY`
   and redeploy.

`ENCRYPTION_KEY` must be ≥32 chars or the server refuses to boot.

## Agent run-data encryption at rest

`AgentExecution` (input/output/transcript/plan) and `ExecutionMessage.content`
are encrypted **in place** (a ciphertext string replaces the object/text) when
`ENCRYPTION_KEY` is set — see `src/lib/agents/run-crypto.ts`. Reads decrypt
transparently and pass legacy plaintext through, so no migration is required.
The nightly retention cron converges pre-cutover rows
(`encryptLegacyAgentRuns`); retention also bounds exposure (transcript/plan
pruned at 14 days, rows deleted at 90). These columns are in `ROTATION_TARGETS`,
enforced by `rotate-coverage.test.ts`.

## Admin MFA enforcement

Cross-owner resource takeover and member role/deactivation changes require a
stepped-up (AAL2) session **once the acting admin has enrolled a second factor**
(`users.mfaEnrolledAt`, stamped automatically the first time a session presents
AAL2). Members who never enrolled are unaffected — no lockout.

- **Break-glass:** `ALLOW_ADMIN_MFA_BYPASS=true` disables enforcement entirely.
  Use only to recover an admin who removed their factor and is locked out of an
  elevated action; remove it once they re-enroll.
- To require MFA org-wide (all members, not just admins), that is a per-workspace
  policy toggle — not yet built; this pass covered admins/platform roles only.

## Egress control & detection

- **Egress allowlist:** set `HTTP_TOOL_ALLOWED_DOMAINS` (comma-separated hosts;
  subdomains match) to restrict outbound HTTP from flows/agents. Unset = allow
  any public host (non-breaking default). A blocked destination emits an
  `egress.blocked` security event; a burst crosses the alert threshold.
- **Alert destination:** set `SECURITY_ALERT_EMAIL`. Unset = events still log
  under `security:` but no email is sent.
- **Detection fails closed:** when the rate-limit backend is unreachable the
  security counter can't evaluate thresholds, so it now emails a
  "detection degraded" alert (deduped per process per hour) instead of going
  silent. Fix the backend to restore counting.
- **Shared rate-limit backend:** production needs `UPSTASH_REDIS_REST_URL` +
  `_TOKEN` (or `REDIS_URL`); without one, limits are per-instance memory and a
  distributed attack may not cross a global threshold. The readiness probe fails
  closed on this.

## Audit trail immutability

`audit_events` is append-only at the database layer (trigger
`audit_events_append_only`): UPDATE is refused, and DELETE is refused for rows
newer than the 90-day retention floor. The only permitted mutation is the
`ON DELETE SET NULL` cascade that nulls `organizationId` when a workspace is
deleted, so the trail survives as readable orphans. The retention sweep prunes
genuinely aged-out rows. To perform authorized maintenance, a superuser can
`SET session_replication_role = replica` to bypass the trigger.

## Still infra-floored (not closed in code)

- **KMS / envelope encryption.** `ENCRYPTION_KEY` is a single env-var data key
  with no KMS wrap and no key-generation id. Moving to envelope encryption
  (a KMS-held KEK wrapping per-record DEKs) requires provisioning AWS KMS /
  Vault / GCP KMS and a key-provider abstraction in `src/lib/crypto/secrets.ts`.
  The rolling-rotation fallback above is the interim control.
- **Workload identity.** Platform secrets (Anthropic, Stripe, Supabase service
  role, etc.) are static env vars. Replacing them with OIDC federation /
  cloud-role credentials is a deployment-platform change (Vercel/Render OIDC),
  not an application change.
