-- Make the audit trail append-only at the DATABASE layer, not just in app code.
--
-- Application code only ever INSERTs audit_events and DELETEs aged-out rows in
-- the retention sweep. Nothing legitimately UPDATEs one, and nothing deletes a
-- recent one. But "append-only in app code" is not a control against anyone
-- (or anything) holding the app's DB credential — an attacker who reaches the
-- database can rewrite or erase history, including the rows recording their own
-- actions. This trigger enforces the invariant where it cannot be bypassed.
--
--   UPDATE : always refused. Audit rows are immutable once written.
--   DELETE : refused for rows newer than the retention floor (90 days). The
--            nightly retention sweep only ever deletes rows older than
--            AUDIT_RETENTION_DAYS, which is floored at 90 (src/lib/audit.ts),
--            so legitimate pruning still succeeds; deleting a recent row to
--            cover tracks does not. A one-day slack (89 days) absorbs any clock
--            skew between the app and the database so retention never races the
--            guard.
--
-- SECURITY DEFINER is deliberately NOT used: the trigger must run with the
-- privileges of whoever issues the write so it cannot be sidestepped.

CREATE OR REPLACE FUNCTION public.audit_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    -- The ONE permitted update: the ON DELETE SET NULL cascade that nulls
    -- organizationId when a workspace is deleted (audit rows deliberately
    -- survive the cascade as readable orphans). Every content column must be
    -- unchanged; anything else — including repointing organizationId to a
    -- different workspace — is tampering and is refused.
    IF (NEW."organizationId" IS NULL
        AND OLD."id" = NEW."id"
        AND OLD."actorUserId" IS NOT DISTINCT FROM NEW."actorUserId"
        AND OLD."actorKind" = NEW."actorKind"
        AND OLD."action" = NEW."action"
        AND OLD."resourceType" IS NOT DISTINCT FROM NEW."resourceType"
        AND OLD."resourceId" IS NOT DISTINCT FROM NEW."resourceId"
        AND OLD."tool" IS NOT DISTINCT FROM NEW."tool"
        AND OLD."executionId" IS NOT DISTINCT FROM NEW."executionId"
        AND OLD."payloadHash" IS NOT DISTINCT FROM NEW."payloadHash"
        AND OLD."detail" IS NOT DISTINCT FROM NEW."detail"
        AND OLD."ip" IS NOT DISTINCT FROM NEW."ip"
        AND OLD."createdAt" = NEW."createdAt") THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit_events is append-only: UPDATE is not permitted';
  END IF;

  IF (TG_OP = 'DELETE') THEN
    IF (OLD."createdAt" >= now() - interval '89 days') THEN
      RAISE EXCEPTION 'audit_events is append-only: cannot delete rows newer than the retention floor';
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS audit_events_no_update ON public.audit_events;
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_events_append_only();

DROP TRIGGER IF EXISTS audit_events_guard_delete ON public.audit_events;
CREATE TRIGGER audit_events_guard_delete
  BEFORE DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_events_append_only();
