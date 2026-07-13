-- Flow Jam uses private Supabase Realtime channels. Authorization is evaluated
-- when an authenticated client joins and is cached by Realtime for that socket.
-- The helper is SECURITY DEFINER because Prisma-owned application tables are
-- not directly exposed to the authenticated Postgres role.
CREATE OR REPLACE FUNCTION public.can_access_flow_jam(topic_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    split_part(topic_name, ':', 1) = 'flow-jam'
    AND EXISTS (
      SELECT 1
      FROM public.users AS app_user
      JOIN public.flows AS flow
        ON flow.id = split_part(topic_name, ':', 2)
       AND flow."organizationId" = app_user."organizationId"
      WHERE app_user."supabaseId" = (SELECT auth.uid())
        AND app_user."isActive" = true
        AND (
          flow."userId" = app_user.id
          OR EXISTS (
            SELECT 1
            FROM public.flow_collaborators AS collaborator
            WHERE collaborator."flowId" = flow.id
              AND collaborator."organizationId" = flow."organizationId"
              AND collaborator."userId" = app_user.id
          )
        )
    );
$$;

REVOKE ALL ON FUNCTION public.can_access_flow_jam(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_flow_jam(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_flow_jam(text) TO service_role;

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "flow_jam_members_can_receive" ON realtime.messages;
CREATE POLICY "flow_jam_members_can_receive"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension IN ('broadcast', 'presence')
  AND public.can_access_flow_jam((SELECT realtime.topic()))
);

DROP POLICY IF EXISTS "flow_jam_members_can_send" ON realtime.messages;
CREATE POLICY "flow_jam_members_can_send"
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (
  realtime.messages.extension IN ('broadcast', 'presence')
  AND public.can_access_flow_jam((SELECT realtime.topic()))
);
