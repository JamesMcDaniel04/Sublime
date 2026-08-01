-- Realtime channel-join helpers must resolve users the way the app does.
--
-- findDbUser (auth-utils) resolves a session to an app user via
-- users."supabaseId" OR a user_identities row — but both SECURITY DEFINER
-- helpers matched users."supabaseId" only. A member signed in through a
-- LINKED identity was refused the channel join: run-status silently degraded
-- to polling, and flow-jam collaboration silently didn't work.

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
      WHERE (
          app_user."supabaseId" = (SELECT auth.uid())
          OR EXISTS (
            SELECT 1
            FROM public.user_identities AS identity
            WHERE identity."userId" = app_user.id
              AND identity."supabaseId" = (SELECT auth.uid())
          )
        )
        AND app_user."isActive" = true
        AND app_user."organizationId"::text = split_part(topic_name, ':', 2)
    );
$$;

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
      WHERE (
          app_user."supabaseId" = (SELECT auth.uid())
          OR EXISTS (
            SELECT 1
            FROM public.user_identities AS identity
            WHERE identity."userId" = app_user.id
              AND identity."supabaseId" = (SELECT auth.uid())
          )
        )
        AND app_user."isActive" = true
        AND (
          flow."userId" = app_user.id
          OR flow.visibility IN ('org_viewer', 'org_editor')
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
