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

  // --- Tranche 2 (2026-08-09), alphabetized ---
  // Bitly v4 auths with `Authorization: Bearer <access token>`.
  bitlyapi: { type: 'bearer', displayName: 'Bitly API' },
  // Calendly v2 auths with `Authorization: Bearer <personal access token>`
  // (the v1 X-TOKEN scheme is retired).
  calendlyapi: { type: 'bearer', displayName: 'Calendly API' },
  // CircleCI auths with a `Circle-Token: <personal API token>` header.
  circleciapi: { type: 'apiKeyHeader', headerName: 'Circle-Token', displayName: 'CircleCI API' },
  // Coda auths with `Authorization: Bearer <API token>`.
  codaapi: { type: 'bearer', displayName: 'Coda API' },
  // Datadog auths with two plain headers: DD-API-KEY (always) and
  // DD-APPLICATION-KEY (required by most read/management endpoints).
  datadogapi: {
    type: 'custom',
    entries: [
      { kind: 'header', name: 'DD-API-KEY' },
      { kind: 'header', name: 'DD-APPLICATION-KEY' },
    ],
    displayName: 'Datadog API',
  },
  // Figma auths with an `X-Figma-Token: <personal access token>` header.
  figmaapi: { type: 'apiKeyHeader', headerName: 'X-Figma-Token', displayName: 'Figma API' },
  // Freshdesk auths with HTTP basic where username is the API key and the
  // password is any placeholder (conventionally `X`).
  freshdeskapi: { type: 'basic', displayName: 'Freshdesk API' },
  // n8n's generic HTTP basic-auth credential IS plain basic auth; only the
  // HTTP Request node's programmatic injection made the generator punt.
  httpbasicauth: { type: 'basic', displayName: 'Basic Auth' },
  // PagerDuty REST v2 auths with `Authorization: Token token=<api key>` — a
  // non-Bearer scheme, so the stored key must include the literal
  // `Token token=` prefix.
  pagerdutyapi: { type: 'apiKeyHeader', headerName: 'Authorization', displayName: 'PagerDuty API' },
  // SurveyMonkey auths with `Authorization: Bearer <access token>`.
  surveymonkeyapi: { type: 'bearer', displayName: 'SurveyMonkey API' },
  // Trello auths with `key` and `token` query parameters.
  trelloapi: {
    type: 'custom',
    entries: [
      { kind: 'query', name: 'key' },
      { kind: 'query', name: 'token' },
    ],
    displayName: 'Trello API',
  },
  // WooCommerce REST auths with HTTP basic over HTTPS: consumer key as
  // username, consumer secret as password.
  woocommerceapi: { type: 'basic', displayName: 'WooCommerce API' },
  // Zendesk API-token auth is HTTP basic with username `<email>/token` (the
  // literal `/token` suffix is required) and the API token as password.
  zendeskapi: { type: 'basic', displayName: 'Zendesk API' },
}
