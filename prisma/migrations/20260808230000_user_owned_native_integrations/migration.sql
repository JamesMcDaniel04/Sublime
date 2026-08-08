-- Native integration credentials are personal even inside a shared org.
-- Existing org-wide rows have no trustworthy owner, so quarantine them and
-- require an explicit reconnect rather than gifting them to an administrator.
ALTER TABLE "integration_secrets" ADD COLUMN "userId" TEXT;
ALTER TABLE "slack_workspace_connections" ADD COLUMN "userId" TEXT;

UPDATE "integration_secrets" SET "isActive" = false WHERE "userId" IS NULL;
UPDATE "slack_workspace_connections" SET "status" = 'revoked' WHERE "userId" IS NULL;

ALTER TABLE "integration_secrets"
  ADD CONSTRAINT "integration_secrets_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slack_workspace_connections"
  ADD CONSTRAINT "slack_workspace_connections_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "integration_secrets_organizationId_provider_key";
DROP INDEX IF EXISTS "integration_secrets_organizationId_isActive_idx";
ALTER TABLE "slack_workspace_connections"
  DROP CONSTRAINT IF EXISTS "slack_workspace_connections_organizationId_teamId_key";

CREATE UNIQUE INDEX "integration_secrets_organizationId_userId_provider_key"
  ON "integration_secrets"("organizationId", "userId", "provider");
CREATE INDEX "integration_secrets_organizationId_userId_isActive_idx"
  ON "integration_secrets"("organizationId", "userId", "isActive");
CREATE UNIQUE INDEX "slack_workspace_connections_organizationId_userId_teamId_key"
  ON "slack_workspace_connections"("organizationId", "userId", "teamId");
CREATE INDEX "slack_workspace_connections_organizationId_userId_status_idx"
  ON "slack_workspace_connections"("organizationId", "userId", "status");

-- Redact legacy credential-shaped values already fanned out into graph
-- drafts, published definitions, version history, and run snapshots. Embedded
-- JSON editor strings remain strings after their parsed contents are cleaned.
CREATE OR REPLACE FUNCTION sublime_redact_flow_credentials(value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  kind TEXT;
  item RECORD;
  result JSONB;
  raw TEXT;
  parsed JSONB;
BEGIN
  IF value IS NULL THEN RETURN value; END IF;
  kind := jsonb_typeof(value);
  IF kind = 'object' THEN
    result := '{}'::jsonb;
    FOR item IN SELECT key, val FROM jsonb_each(value) AS entries(key, val) LOOP
      IF item.key ~* '(^|[_\-.])(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|passphrase|credential|auth|authorization|bearer|session[_-]?id|signature|private[_-]?key)([_\-.]|$)'
         AND jsonb_typeof(item.val) = 'string'
         AND (item.val #>> '{}') !~ '^\{\{\s*[^{}]+\s*\}\}$' THEN
        result := result || jsonb_build_object(item.key, 'redacted');
      ELSIF item.key = 'value'
         AND value ? 'type'
         AND jsonb_typeof(item.val) = 'string'
         AND (item.val #>> '{}') !~ '^\{\{\s*[^{}]+\s*\}\}$' THEN
        result := result || jsonb_build_object(item.key, 'redacted');
      ELSIF item.key = 'url' AND jsonb_typeof(item.val) = 'string' THEN
        raw := item.val #>> '{}';
        raw := regexp_replace(raw, '^(https://)[^/@]+@', '\1', 'i');
        raw := regexp_replace(
          raw,
          '([?&](api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|signature|session[_-]?id)=)[^&#]*',
          '\1redacted',
          'gi'
        );
        result := result || jsonb_build_object(item.key, raw);
      ELSE
        result := result || jsonb_build_object(item.key, sublime_redact_flow_credentials(item.val));
      END IF;
    END LOOP;
    RETURN result;
  ELSIF kind = 'array' THEN
    SELECT COALESCE(jsonb_agg(sublime_redact_flow_credentials(element)), '[]'::jsonb)
      INTO result FROM jsonb_array_elements(value) AS elements(element);
    RETURN result;
  ELSIF kind = 'string' THEN
    raw := value #>> '{}';
    IF left(ltrim(raw), 1) IN ('{', '[') THEN
      BEGIN
        parsed := raw::jsonb;
        RETURN to_jsonb(sublime_redact_flow_credentials(parsed)::text);
      EXCEPTION WHEN others THEN
        RETURN value;
      END;
    END IF;
  END IF;
  RETURN value;
END;
$$;

UPDATE "flows" SET
  "graph" = sublime_redact_flow_credentials("graph"),
  "publishedGraph" = CASE WHEN "publishedGraph" IS NULL THEN NULL ELSE sublime_redact_flow_credentials("publishedGraph") END;
UPDATE "flow_versions" SET "graph" = sublime_redact_flow_credentials("graph");
UPDATE "flow_runs" SET "graphSnapshot" = sublime_redact_flow_credentials("graphSnapshot")
  WHERE "graphSnapshot" IS NOT NULL;

DROP FUNCTION sublime_redact_flow_credentials(JSONB);
