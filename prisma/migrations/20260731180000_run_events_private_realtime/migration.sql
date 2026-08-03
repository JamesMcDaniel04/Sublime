-- Run-event delivery over private Supabase Realtime channels.
--
-- Topic: run-events:<organizationId>. Clients RECEIVE only (no INSERT policy
-- for authenticated) — events are sent by the server/worker via the service
-- role, which bypasses RLS. Authorization mirrors the flow-jam pattern:
-- membership is evaluated at channel join via a SECURITY DEFINER helper
-- because Prisma-owned tables are not exposed to the authenticated role.
CREATE OR REPLACE FUNCTION public.can_access_run_events(topic_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    split_part(topic_name, ':', 1) = 'run-events'
    AND EXISTS (
      SELECT 1
      FROM public.users AS app_user
      WHERE app_user."supabaseId" = (SELECT auth.uid())
        AND app_user."isActive" = true
        AND app_user."organizationId"::text = split_part(topic_name, ':', 2)
    );
$$;

REVOKE ALL ON FUNCTION public.can_access_run_events(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_run_events(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_run_events(text) TO service_role;

-- Supabase now locks the realtime schema to its owning admin role. Older
-- projects allowed the application migration role to manage these policies;
-- newer projects raise 42501. Keep application migrations deployable and
-- preserve the polling fallback, while installing the policy whenever the
-- connected role still owns the table. Locked projects apply the identical
-- owner-level statement from supabase/run-events-policy.sql.
DO $policy$
BEGIN
  ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS "run_events_members_can_receive" ON realtime.messages;
  CREATE POLICY "run_events_members_can_receive"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND public.can_access_run_events((SELECT realtime.topic()))
  );
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING 'run-events Realtime policy requires the Supabase owner role; polling remains authoritative until supabase/run-events-policy.sql is applied';
END
$policy$;
