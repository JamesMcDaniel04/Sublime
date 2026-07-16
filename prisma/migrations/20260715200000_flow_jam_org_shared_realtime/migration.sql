-- Flow Jam Realtime authorization must mirror the API's flowReadScope: owner,
-- invited collaborator, OR any org share (org_viewer / org_editor). The first
-- version of can_access_flow_jam only admitted owner + collaborators, so a
-- teammate on an org-shared flow was handed a channel topic by the API and then
-- rejected by Realtime RLS — presence and live cursors never connected for them.
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
