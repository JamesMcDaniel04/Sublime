# Generated n8n credential map — design

**Date:** 2026-08-07
**Branch:** feat/flow-import
**Status:** Approved (scope: table + importer + form prefill)

## Problem

The n8n importer guesses the Sublime vault credential type from the n8n credential *name* (`vaultTypeFor`, `src/lib/import/n8n.ts:54`). Replayed against all 392 real n8n credential definitions, the guess is wrong 43% of the time (115/266 classifiable; the dominant miss defaults to `bearer` when the API actually wants a non-Authorization header such as `X-API-Key`). The guess also cannot supply the header/query *name* the API expects, and cannot distinguish credentials that generic injection can never reproduce (126 of 392 authenticate programmatically — OAuth1 signing, SigV4, rotating tokens). Downstream, the bulk-bind dialog pre-selects a credential type that is frequently wrong and always generic, which is why imported credentials feel untailored.

## Goal

Imported n8n credential references pre-select the **correct** vault type, pre-fill the **real** header/query name in the credential-create form, and warn honestly when a credential cannot be represented by vault injection at all.

## Non-goals

- Per-integration credential presets in the general (non-import) credential picker — follow-up.
- Runtime dependency on any n8n package.
- OAuth authorization-code flows in the vault (stays on the connection plane).

## Design

### 1. Generation script (offline, manual)

`scripts/generate-n8n-credential-map.ts` — run by a developer against a throwaway install of `n8n-nodes-base` (+ `n8n-core`, `qs` peer deps); never part of the build. For each credential class exported in the package's `n8n.credentials` manifest, instantiate it and classify by the **actual `authenticate` recipe**:

| Recipe observed | Mapped entry |
|---|---|
| `headers: { Authorization: "=Bearer {{…}}" }` | `{ type: 'bearer' }` |
| `headers: { Authorization: "=Basic …" }` or `auth: {…}` | `{ type: 'basic' }` |
| single non-Authorization header | `{ type: 'apiKeyHeader', headerName }` |
| single `qs` param | `{ type: 'apiKeyQuery', queryParam }` |
| multiple headers/params (static names) | `{ type: 'custom', entries: [{kind, name}] }` |
| `extends` includes `oAuth2Api` | `{ type: 'oauth2' }` |
| in `NANGO_CREDENTIAL_MAP` | excluded (stays connection-plane; existing behavior) |
| body-based, OAuth1, or no generic recipe | `{ type: 'unsupported' }` |

Recipes whose header/param *names* are expressions (computed at runtime) classify as `unsupported` — a prefilled wrong name is worse than none. Every entry also carries `displayName` (n8n's human label). Keys are lower-cased n8n credential type names, matching the importer's existing normalization.

The script asserts ≥300 entries and prints a classification histogram, then writes the table sorted by key (stable diffs). Regeneration cadence: on demand, when import fidelity reports point at a missing/changed credential.

### 2. Checked-in table

`src/lib/import/n8n-credential-map.json` — the generated output. Factual data only (auth mechanism, header/query names, display names); no n8n source code is copied, keeping Sustainable-Use-License exposure nil.

```ts
type N8nCredentialMapEntry =
  | { type: 'basic' | 'bearer' | 'oauth2'; displayName: string }
  | { type: 'apiKeyHeader'; headerName: string; displayName: string }
  | { type: 'apiKeyQuery'; queryParam: string; displayName: string }
  | { type: 'custom'; entries: { kind: 'header' | 'query'; name: string }[]; displayName: string }
  | { type: 'unsupported'; reason: string; displayName: string }
```

### 3. Importer changes (`src/lib/import/n8n.ts`, `src/lib/import/types.ts`)

- `vaultTypeFor` becomes a table lookup; the current name heuristic survives only as the fallback for credential types absent from the table (newer than the generation run).
- `CredentialGroup.credentialType` union widens with `'apiKeyQuery' | 'custom'`; the group gains optional `suggestedHeaderName`, `suggestedQueryParam`, `suggestedEntries`, `sourceDisplayName`, and `unsupported?: { reason: string }`.
- `unsupported` groups still appear in the report (provenance) but produce a per-group import warning ("n8n authenticates X programmatically — connect it as an integration or configure auth manually") and the affected http steps keep `authMode: 'generic'` with **no** pre-set `credentialType` rather than a wrong one.

### 4. Bulk-bind dialog + create-form prefill

- `src/components/flows/import-flow-dialog.tsx`: each group row shows the mapped display name and correct type; unsupported groups render the warning state instead of a create button.
- The credential-create form (`src/lib/credentials/form.ts` consumers) accepts optional initial values so the dialog can pre-select the type and prefill `headerName` / `queryParam` / custom `entries` names (values stay empty — secrets never travel). No change to storage or validation; this is purely initial form state.

## Error handling

- Table missing/malformed at import time is impossible by construction (checked-in JSON, typed accessor with a parse-once module cache); a test asserts the shipped table parses and meets the size floor.
- Generation script failures (missing peer dep, class throwing on construction) are per-entry: logged, entry skipped, and the histogram makes drops visible; the ≥300 assertion stops a gutted table from being committed.

## Testing

- Classifier unit tests against fixture credential definitions covering every recipe row above, including the expression-valued-name → `unsupported` rule.
- Importer tests: a name the old heuristic misclassified (e.g. an `X-API-Key` credential) now maps to `apiKeyHeader` with the right `headerName`; unknown name falls back to the heuristic; `unsupported` yields the warning and no pre-set type; existing NANGO_CREDENTIAL_MAP behavior unchanged.
- Table sanity test: parses, ≥300 entries, every entry matches the union.
- Dialog test: unsupported group renders warning state; supported group passes prefill props.
