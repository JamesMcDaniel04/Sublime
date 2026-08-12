-- Make the grandfathered admin grant explicit in the database.
--
-- Accounts that existed before paid-from-day-one were promised unrestricted
-- internal/test access, and the app delivered the ADMIN half of that promise by
-- rewriting `role` in memory on every request whenever
-- `createdAt <= GRANDFATHERED_WORKSPACE_CUTOFF`. That had two problems: the
-- elevation was invisible (the column still read MEMBER, so the members list and
-- any audit disagreed with the behaviour), and it was derived from a field that
-- is not identity — an import, a restore, a seed, or a clock skew that lands an
-- old createdAt would mint an admin.
--
-- This writes the grant down once. Afterwards `users.role` is the single source
-- of truth and the runtime date comparison is gone (see
-- src/lib/supabase/auth-utils.ts). Grandfathered BILLING is untouched and still
-- derives from Organization.grandfatheredAt / createdAt — only the authorization
-- role moves.
--
-- Idempotent: re-running promotes nothing new, and it never demotes anyone.
UPDATE "users"
SET "role" = 'ADMIN', "updatedAt" = NOW()
WHERE "role" = 'MEMBER'
  AND "createdAt" <= TIMESTAMPTZ '2026-07-19 20:31:00+00';
