/**
 * Hand-curated corrections for n8n credentials the generated table marks
 * `unsupported` ONLY because their n8n nodes inject auth in node code (no
 * declarative authenticate block) — while the vendor API itself uses plain
 * header auth the vault can reproduce. Consulted before the generated table,
 * so regeneration never clobbers these. Keep entries CERTAIN: a wrong prefill
 * is worse than an honest unsupported.
 */
import type { N8nCredentialMapEntry } from './n8n-credential-classify'

export const N8N_CREDENTIAL_OVERRIDES: Record<string, N8nCredentialMapEntry> = {
  // Notion API auths with `Authorization: Bearer <integration secret>`; the
  // required Notion-Version header is request metadata, not a credential.
  notionapi: { type: 'bearer', displayName: 'Notion API' },
  // OpenAI auths with `Authorization: Bearer <api key>`.
  openaiapi: { type: 'bearer', displayName: 'OpenAI' },
  // Airtable legacy API keys auth with `Authorization: Bearer <key>` (same
  // scheme as the newer personal access tokens).
  airtableapi: { type: 'bearer', displayName: 'Airtable API' },
  // SeaTable auths with `Authorization: Token <api token>` — a non-Bearer
  // scheme on the Authorization header, so the stored key must include the
  // literal `Token ` prefix.
  seatableapi: { type: 'apiKeyHeader', headerName: 'Authorization', displayName: 'SeaTable API' },
}
