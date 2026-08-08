# Generated n8n Credential Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the n8n importer's name-sniffing credential-type guess (wrong 43% of the time) with a table generated from n8n's real credential definitions, and carry the correct type + header/query names all the way into the bulk-bind dialog's create-credential form.

**Architecture:** A pure classifier function turns one n8n credential definition into a map entry; an offline script runs it over `n8n-nodes-base` and writes a checked-in JSON table; the importer looks types up in the table (old heuristic kept as fallback for unknown names); the import dialog seeds the credential-create form from the mapped entry. Spec: `docs/superpowers/specs/2026-08-07-n8n-credential-map-design.md`.

**Tech Stack:** TypeScript, Next.js, node:test via `npm test` (tsx runner), no new runtime dependencies.

## Global Constraints

- Never import `n8n-nodes-base`/`n8n-workflow`/`n8n-core` from app code — only the offline script touches them, and only via a caller-supplied install dir.
- The generated JSON contains factual data only (auth mechanism, header/query/display names) — never copied n8n source code.
- Run a single test file with: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test <path>`; full checks with `npm run typecheck`.
- Repo gotcha: concurrent commits can land mid-session — `git add` specific paths, never `git add -A`.

---

### Task 1: Classifier module

**Files:**
- Create: `src/lib/import/n8n-credential-classify.ts`
- Test: `src/lib/import/__tests__/n8n-credential-classify.test.ts`

**Interfaces:**
- Produces: `type N8nCredentialMapEntry` (discriminated on `type`), `classifyN8nCredential(def: N8nCredentialDef): N8nCredentialMapEntry`, `type N8nCredentialDef`. Tasks 2–4 import `N8nCredentialMapEntry` from this module.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/import/__tests__/n8n-credential-classify.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyN8nCredential, type N8nCredentialDef } from '@/lib/import/n8n-credential-classify'

const def = (over: Partial<N8nCredentialDef>): N8nCredentialDef => ({
  name: 'exampleApi', displayName: 'Example API', extends: [], authenticate: undefined, ...over,
})

test('Authorization Bearer header classifies as bearer', () => {
  const entry = classifyN8nCredential(def({
    authenticate: { type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.accessToken}}' } } },
  }))
  assert.deepEqual(entry, { type: 'bearer', displayName: 'Example API' })
})

test('Authorization Basic header classifies as basic', () => {
  const entry = classifyN8nCredential(def({
    authenticate: { type: 'generic', properties: { headers: { Authorization: '=Basic {{$credentials.encoded}}' } } },
  }))
  assert.equal(entry.type, 'basic')
})

test('auth block classifies as basic', () => {
  const entry = classifyN8nCredential(def({
    authenticate: { type: 'generic', properties: { auth: { username: '={{$credentials.user}}', password: '={{$credentials.pass}}' } } },
  }))
  assert.equal(entry.type, 'basic')
})

test('single non-Authorization header carries the real header name', () => {
  const entry = classifyN8nCredential(def({
    authenticate: { type: 'generic', properties: { headers: { 'X-API-Key': '={{$credentials.apiKey}}' } } },
  }))
  assert.deepEqual(entry, { type: 'apiKeyHeader', headerName: 'X-API-Key', displayName: 'Example API' })
})

test('Authorization header with a non-bearer scheme is apiKeyHeader on Authorization', () => {
  const entry = classifyN8nCredential(def({
    authenticate: { type: 'generic', properties: { headers: { Authorization: '=Token {{$credentials.apiKey}}' } } },
  }))
  assert.deepEqual(entry, { type: 'apiKeyHeader', headerName: 'Authorization', displayName: 'Example API' })
})

test('single qs param carries the real param name', () => {
  const entry = classifyN8nCredential(def({
    authenticate: { type: 'generic', properties: { qs: { api_key: '={{$credentials.apiKey}}' } } },
  }))
  assert.deepEqual(entry, { type: 'apiKeyQuery', queryParam: 'api_key', displayName: 'Example API' })
})

test('multiple static headers/params classify as custom with named entries', () => {
  const entry = classifyN8nCredential(def({
    authenticate: { type: 'generic', properties: {
      headers: { 'X-App-Id': '={{$credentials.id}}', 'X-App-Key': '={{$credentials.key}}' },
      qs: { region: '={{$credentials.region}}' },
    } },
  }))
  assert.deepEqual(entry, {
    type: 'custom',
    entries: [
      { kind: 'header', name: 'X-App-Id' },
      { kind: 'header', name: 'X-App-Key' },
      { kind: 'query', name: 'region' },
    ],
    displayName: 'Example API',
  })
})

test('extends oAuth2Api classifies as oauth2, oAuth1Api as oauth1', () => {
  assert.equal(classifyN8nCredential(def({ extends: ['oAuth2Api'] })).type, 'oauth2')
  assert.equal(classifyN8nCredential(def({ extends: ['oAuth1Api'] })).type, 'oauth1')
})

test('body-based auth is unsupported', () => {
  const entry = classifyN8nCredential(def({
    authenticate: { type: 'generic', properties: { body: { token: '={{$credentials.token}}' } } },
  }))
  assert.equal(entry.type, 'unsupported')
})

test('no recipe and no extends is unsupported (programmatic auth)', () => {
  const entry = classifyN8nCredential(def({}))
  assert.deepEqual(entry, { type: 'unsupported', reason: 'programmatic', displayName: 'Example API' })
})

test('expression-valued header NAME is unsupported — a wrong prefilled name is worse than none', () => {
  const entry = classifyN8nCredential(def({
    authenticate: { type: 'generic', properties: { headers: { '={{$credentials.headerName}}': '=x' } } },
  }))
  assert.equal(entry.type, 'unsupported')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/import/__tests__/n8n-credential-classify.test.ts`
Expected: FAIL — cannot find module `@/lib/import/n8n-credential-classify`

- [ ] **Step 3: Implement the classifier**

```ts
// src/lib/import/n8n-credential-classify.ts
/**
 * Classifies one n8n credential definition into a vault-mapping entry by its
 * ACTUAL injection recipe (the `authenticate` block), not its name. Pure so
 * it unit-tests without the n8n packages; scripts/generate-n8n-credential-map.ts
 * feeds it instances loaded from n8n-nodes-base.
 */

/** The subset of n8n's ICredentialType the classifier reads. */
export type N8nCredentialDef = {
  name: string
  displayName: string
  extends?: string[]
  authenticate?: {
    type?: string
    properties?: {
      headers?: Record<string, unknown>
      qs?: Record<string, unknown>
      auth?: Record<string, unknown>
      body?: Record<string, unknown>
    }
  }
}

export type N8nCredentialMapEntry =
  | { type: 'basic' | 'bearer' | 'oauth1' | 'oauth2'; displayName: string }
  | { type: 'apiKeyHeader'; headerName: string; displayName: string }
  | { type: 'apiKeyQuery'; queryParam: string; displayName: string }
  | { type: 'custom'; entries: { kind: 'header' | 'query'; name: string }[]; displayName: string }
  | { type: 'unsupported'; reason: string; displayName: string }

/** A name computed at runtime can't prefill a form — treat as unsupported. */
const isDynamicName = (name: string) => name.includes('{{') || name.startsWith('=')

export function classifyN8nCredential(def: N8nCredentialDef): N8nCredentialMapEntry {
  const displayName = def.displayName || def.name
  const props = def.authenticate?.properties

  if (!props) {
    if (def.extends?.some((base) => /oauth2/i.test(base))) return { type: 'oauth2', displayName }
    if (def.extends?.some((base) => /oauth1/i.test(base))) return { type: 'oauth1', displayName }
    return { type: 'unsupported', reason: 'programmatic', displayName }
  }
  if (props.body && Object.keys(props.body).length) return { type: 'unsupported', reason: 'bodyAuth', displayName }
  if (props.auth) return { type: 'basic', displayName }

  const headers = Object.keys(props.headers ?? {})
  const query = Object.keys(props.qs ?? {})
  if ([...headers, ...query].some(isDynamicName)) return { type: 'unsupported', reason: 'dynamicName', displayName }

  if (headers.length + query.length > 1) {
    return {
      type: 'custom',
      entries: [
        ...headers.map((name) => ({ kind: 'header' as const, name })),
        ...query.map((name) => ({ kind: 'query' as const, name })),
      ],
      displayName,
    }
  }
  if (query.length === 1) return { type: 'apiKeyQuery', queryParam: query[0], displayName }
  if (headers.length === 1) {
    const name = headers[0]
    const value = String((props.headers ?? {})[name] ?? '')
    if (name.toLowerCase() === 'authorization') {
      if (/^=?\s*bearer\b/i.test(value)) return { type: 'bearer', displayName }
      if (/^=?\s*basic\b/i.test(value)) return { type: 'basic', displayName }
    }
    return { type: 'apiKeyHeader', headerName: name, displayName }
  }
  return { type: 'unsupported', reason: 'emptyRecipe', displayName }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/import/__tests__/n8n-credential-classify.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/import/n8n-credential-classify.ts src/lib/import/__tests__/n8n-credential-classify.test.ts
git commit -m "feat(import): classifier for n8n credential definitions"
```

---

### Task 2: Generation script + checked-in table + accessor

**Files:**
- Create: `scripts/generate-n8n-credential-map.ts`
- Create: `src/lib/import/n8n-credential-map.json` (generated — do not hand-edit)
- Create: `src/lib/import/n8n-credential-map.ts`
- Test: `src/lib/import/__tests__/n8n-credential-map.test.ts`

**Interfaces:**
- Consumes: `classifyN8nCredential`, `N8nCredentialDef`, `N8nCredentialMapEntry` from Task 1.
- Produces: `lookupN8nCredential(sourceType: string): N8nCredentialMapEntry | undefined` (key is lower-cased n8n credential type name) from `@/lib/import/n8n-credential-map`. Tasks 3–4 use it.

- [ ] **Step 1: Write the failing table sanity test**

```ts
// src/lib/import/__tests__/n8n-credential-map.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lookupN8nCredential, N8N_CREDENTIAL_MAP_SIZE } from '@/lib/import/n8n-credential-map'

test('table meets the size floor so a gutted regeneration cannot ship', () => {
  assert.ok(N8N_CREDENTIAL_MAP_SIZE >= 300, `only ${N8N_CREDENTIAL_MAP_SIZE} entries`)
})

test('lookup is case-insensitive on the n8n credential type name', () => {
  const entry = lookupN8nCredential('NotionApi')
  assert.ok(entry, 'notionApi missing from table')
})

test('a known non-Authorization-header credential maps with its real header name', () => {
  // n8n's Notion credential injects Authorization: Bearer; use airtableTokenApi (bearer)
  // and a known X-API-Key style one for shape coverage.
  const cal = lookupN8nCredential('calApi') // Cal.com uses a plain apiKey query/header
  assert.ok(cal, 'calApi missing from table')
})

test('every entry matches the discriminated union', async () => {
  const { default: table } = await import('@/lib/import/n8n-credential-map.json', { with: { type: 'json' } })
  for (const [key, entry] of Object.entries(table as Record<string, { type: string }>)) {
    assert.ok(['basic', 'bearer', 'oauth1', 'oauth2', 'apiKeyHeader', 'apiKeyQuery', 'custom', 'unsupported'].includes(entry.type), `${key} has type ${entry.type}`)
    assert.equal(key, key.toLowerCase(), `${key} key not lower-cased`)
  }
})
```

(If the JSON-import-attribute syntax fails under the tsx test runner, read the file with `fs.readFileSync` + `JSON.parse` instead — assert the same shapes.)

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/import/__tests__/n8n-credential-map.test.ts`
Expected: FAIL — module/JSON not found

- [ ] **Step 3: Write the generation script**

```ts
// scripts/generate-n8n-credential-map.ts
/**
 * Regenerates src/lib/import/n8n-credential-map.json from n8n's published
 * credential definitions. Run manually, never in the build:
 *
 *   npm install --prefix /tmp/n8n-truth n8n-nodes-base n8n-core qs --no-save
 *   npx tsx scripts/generate-n8n-credential-map.ts /tmp/n8n-truth
 *
 * Output is factual data only (auth mechanism + header/query/display names);
 * no n8n source is copied. Sorted by key for stable diffs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { classifyN8nCredential, type N8nCredentialMapEntry } from '../src/lib/import/n8n-credential-classify'

const installDir = process.argv[2]
if (!installDir) {
  console.error('Usage: tsx scripts/generate-n8n-credential-map.ts <dir containing node_modules/n8n-nodes-base>')
  process.exit(1)
}
const req = createRequire(path.join(path.resolve(installDir), 'noop.js'))
const basePath = path.dirname(req.resolve('n8n-nodes-base/package.json'))
const manifest = req('n8n-nodes-base/package.json') as { n8n: { credentials: string[] } }

const table: Record<string, N8nCredentialMapEntry> = {}
const histogram: Record<string, number> = {}
const failures: string[] = []

for (const credPath of manifest.n8n.credentials) {
  try {
    const mod = req(path.join(basePath, credPath))
    const Cls = mod[Object.keys(mod)[0]]
    const inst = new Cls()
    const entry = classifyN8nCredential({
      name: inst.name,
      displayName: inst.displayName,
      extends: inst.extends,
      authenticate: inst.authenticate,
    })
    table[String(inst.name).toLowerCase()] = entry
    histogram[entry.type] = (histogram[entry.type] ?? 0) + 1
  } catch (error) {
    failures.push(`${credPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const size = Object.keys(table).length
if (size < 300) {
  console.error(`Refusing to write a gutted table (${size} entries). Failures:\n${failures.join('\n')}`)
  process.exit(1)
}
const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)))
const outPath = path.join(__dirname, '..', 'src', 'lib', 'import', 'n8n-credential-map.json')
fs.writeFileSync(outPath, `${JSON.stringify(sorted, null, 1)}\n`)
console.log(`Wrote ${size} entries to ${outPath}`)
console.log('Classification histogram:', histogram)
if (failures.length) console.log(`Skipped ${failures.length} definitions:\n${failures.join('\n')}`)
```

- [ ] **Step 4: Run the script against a throwaway install and eyeball the histogram**

```bash
npm install --prefix /tmp/n8n-truth n8n-nodes-base n8n-core qs --no-save
npx tsx scripts/generate-n8n-credential-map.ts /tmp/n8n-truth
```

Expected: `Wrote ~380+ entries`, histogram roughly: bearer ~100+, oauth2 ~100, apiKeyHeader ~60+, unsupported ~100+, plus small basic/apiKeyQuery/custom/oauth1 buckets. Spot-check three entries in the JSON against n8n source (e.g. `notionapi` → bearer; a known X-API-Key credential → apiKeyHeader with that header name; an OAuth2 one → oauth2).

- [ ] **Step 5: Write the accessor**

```ts
// src/lib/import/n8n-credential-map.ts
/**
 * Checked-in table generated by scripts/generate-n8n-credential-map.ts —
 * n8n credential type name (lower-cased) → how the vault can represent it.
 * Regenerate when import fidelity reports point at a missing/changed type.
 */
import table from './n8n-credential-map.json'
import type { N8nCredentialMapEntry } from './n8n-credential-classify'

const MAP = table as Record<string, N8nCredentialMapEntry>

export const N8N_CREDENTIAL_MAP_SIZE = Object.keys(MAP).length

export function lookupN8nCredential(sourceType: string): N8nCredentialMapEntry | undefined {
  return MAP[sourceType.toLowerCase()]
}
```

(If `tsconfig.json` lacks `resolveJsonModule`, add it — check first; Next.js defaults usually include it.)

- [ ] **Step 6: Run the sanity test and the classifier test**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/import/__tests__/n8n-credential-map.test.ts src/lib/import/__tests__/n8n-credential-classify.test.ts`
Expected: all PASS. If `calApi`/`notionapi` turn out absent from n8n's manifest, swap the test's example keys for two entries that ARE in the generated JSON — the point is shape coverage, not those specific vendors.

- [ ] **Step 7: Commit**

```bash
git add scripts/generate-n8n-credential-map.ts src/lib/import/n8n-credential-map.json src/lib/import/n8n-credential-map.ts src/lib/import/__tests__/n8n-credential-map.test.ts
git commit -m "feat(import): generated n8n credential mapping table + accessor"
```

---

### Task 3: Importer integration

**Files:**
- Modify: `src/lib/import/types.ts:19-29` (CredentialGroup)
- Modify: `src/lib/import/n8n.ts:53-60` (vaultTypeFor), `~:713-726` (http step credential wiring), `~:1303-1332` (collectCredentials)
- Test: `src/lib/import/__tests__/n8n-import.test.ts` (append)

**Interfaces:**
- Consumes: `lookupN8nCredential` from Task 2.
- Produces: widened `CredentialGroup`:

```ts
export type CredentialGroup = {
  key: string
  sourceType: string
  name: string
  /** Vault credential type the picker should pre-select. Absent when unsupported. */
  credentialType?: 'basic' | 'bearer' | 'oauth1' | 'oauth2' | 'apiKeyHeader' | 'apiKeyQuery' | 'custom'
  /** Prefill for the credential-create form — names only, secrets never travel. */
  suggestedHeaderName?: string
  suggestedQueryParam?: string
  suggestedEntries?: { kind: 'header' | 'query'; name: string }[]
  /** n8n's human label for the credential type (e.g. "Notion API"). */
  sourceDisplayName?: string
  /** Set when generic injection cannot reproduce this credential's auth. */
  unsupported?: { reason: string }
  nodeIds: string[]
}
```

Task 4 renders these fields; the import route passes the group objects through untouched.

- [ ] **Step 1: Write the failing tests** (append to `n8n-import.test.ts`, matching its existing helpers/style — read the file's existing n8n workflow fixtures first and reuse them)

```ts
test('credential type comes from the generated table, not the name heuristic', () => {
  // seatableApi injects a non-Authorization header; the old name heuristic said bearer.
  // Use any table entry with type apiKeyHeader — assert via the table so the test
  // stays true across regenerations.
  const workflow = {
    nodes: [
      { id: 'a', name: 'Web', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'b', name: 'Call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [0, 0], parameters: { url: 'https://api.example.com' }, credentials: { seatableApi: { id: 'c1', name: 'My SeaTable' } } },
    ],
    connections: { Web: { main: [[{ node: 'Call', type: 'main', index: 0 }]] } },
  }
  const result = fromN8nWorkflow(workflow)
  const group = result.credentialGroups?.find((g) => g.sourceType === 'seatableApi')
  assert.ok(group)
  assert.equal(group.credentialType, 'apiKeyHeader')
  assert.ok(group.suggestedHeaderName) // the real header name from n8n's definition
  assert.equal(group.sourceDisplayName, 'SeaTable API')
})

test('unknown credential type falls back to the name heuristic', () => {
  const workflow = {
    nodes: [
      { id: 'a', name: 'Web', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'b', name: 'Call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [0, 0], parameters: { url: 'https://api.example.com' }, credentials: { brandNewThingOAuth2Api: { id: 'c1', name: 'X' } } },
    ],
    connections: { Web: { main: [[{ node: 'Call', type: 'main', index: 0 }]] } },
  }
  const group = fromN8nWorkflow(workflow).credentialGroups?.find((g) => g.sourceType === 'brandNewThingOAuth2Api')
  assert.equal(group?.credentialType, 'oauth2')
})

test('unsupported credential warns and does not pre-set a type on the step', () => {
  // Pick a real programmatic-auth credential from the table (type unsupported), e.g. aws.
  const workflow = {
    nodes: [
      { id: 'a', name: 'Web', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'b', name: 'Call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [0, 0], parameters: { url: 'https://api.example.com' }, credentials: { aws: { id: 'c1', name: 'AWS' } } },
    ],
    connections: { Web: { main: [[{ node: 'Call', type: 'main', index: 0 }]] } },
  }
  const result = fromN8nWorkflow(workflow)
  const group = result.credentialGroups?.find((g) => g.sourceType === 'aws')
  assert.ok(group?.unsupported)
  assert.equal(group?.credentialType, undefined)
  const step = result.graph.nodes.find((n) => n.id !== 'trigger' && n.type === 'http')
  assert.equal((step?.data as Record<string, unknown>).credentialType, undefined)
  assert.ok(result.warnings.some((w) => w.includes('AWS') || w.includes('aws')))
})

test('nango-served OAuth credentials still bind as connections, not vault groups', () => {
  const workflow = {
    nodes: [
      { id: 'a', name: 'Web', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'b', name: 'Call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [0, 0], parameters: { url: 'https://slack.com/api/x' }, credentials: { slackOAuth2Api: { id: 'c1', name: 'Slack' } } },
    ],
    connections: { Web: { main: [[{ node: 'Call', type: 'main', index: 0 }]] } },
  }
  const result = fromN8nWorkflow(workflow)
  assert.ok(!result.credentialGroups?.some((g) => g.sourceType === 'slackOAuth2Api'))
})
```

Adjust example credential names to ones actually present in the generated table with the needed classification (verify with `node -e` against the JSON before finalizing the tests; keep the assertions structural).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/import/__tests__/n8n-import.test.ts`
Expected: new tests FAIL (missing fields); existing tests PASS.

- [ ] **Step 3: Implement**

In `types.ts`: replace `CredentialGroup` with the widened shape above (note `credentialType` becomes optional).

In `n8n.ts`:

```ts
import { lookupN8nCredential } from './n8n-credential-map'

/** Table lookup first; the name heuristic survives only for types newer than the table. */
function vaultCredentialInfo(sourceType: string): Pick<CredentialGroup, 'credentialType' | 'suggestedHeaderName' | 'suggestedQueryParam' | 'suggestedEntries' | 'sourceDisplayName' | 'unsupported'> {
  const entry = lookupN8nCredential(sourceType)
  if (!entry) return { credentialType: vaultTypeFor(sourceType) }
  switch (entry.type) {
    case 'unsupported':
      return { sourceDisplayName: entry.displayName, unsupported: { reason: entry.reason } }
    case 'apiKeyHeader':
      return { credentialType: 'apiKeyHeader', suggestedHeaderName: entry.headerName, sourceDisplayName: entry.displayName }
    case 'apiKeyQuery':
      return { credentialType: 'apiKeyQuery', suggestedQueryParam: entry.queryParam, sourceDisplayName: entry.displayName }
    case 'custom':
      return { credentialType: 'custom', suggestedEntries: entry.entries, sourceDisplayName: entry.displayName }
    default:
      return { credentialType: entry.type, sourceDisplayName: entry.displayName }
  }
}
```

- `collectCredentials`'s `record()`: spread `vaultCredentialInfo(sourceType)` into the new group instead of `credentialType: vaultTypeFor(sourceType)`. When the info is `unsupported`, push one warning per GROUP (not per node): `` `n8n authenticates “${info.sourceDisplayName ?? sourceType}” programmatically — connect it as an integration or configure the step's auth manually.` `` (mirror how existing warnings are collected in this function's scope; they dedupe at return).
- The http-step wiring (where `{ authMode: 'generic', credentialType: vaultTypeFor(...) }` is set, ~`:718-721`): use the same `vaultCredentialInfo`; when `credentialType` is undefined (unsupported), set `authMode: 'generic'` with NO `credentialType` key.
- Keep `vaultTypeFor` (unexported is fine) as the fallback only.
- Check `httpStepDataSchema`'s `credentialType` field in `src/lib/flows/graph.ts` (~:163-246): if it's an enum missing `apiKeyQuery`/`custom`/`oauth1`/`digest`, widen it to the full `CredentialType` union from `src/lib/credentials/types.ts` — the vault supports all 8, so the graph schema should not be narrower.

- [ ] **Step 4: Run the import test suite + fuzz suite**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/import/__tests__/n8n-import.test.ts src/lib/import/__tests__/n8n-fuzz.test.ts src/lib/import/__tests__/detect.test.ts src/lib/import/__tests__/sanitize.test.ts`
Expected: all PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/import/types.ts src/lib/import/n8n.ts src/lib/import/__tests__/n8n-import.test.ts src/lib/flows/graph.ts
git commit -m "feat(import): table-driven credential mapping with honest unsupported handling"
```

(Only add `src/lib/flows/graph.ts` if Step 3 actually changed it.)

---

### Task 4: Dialog + create-form prefill

**Files:**
- Modify: `src/components/credentials/credential-picker.tsx` (~:86-91 `startCredentialDraft`, props)
- Modify: `src/components/flows/import-flow-dialog.tsx` (~:29-34 report type, ~:168-190 group rendering)
- Test: manual + typecheck (repo has no component test harness; runtime behavior is covered by Task 3's importer tests feeding the same report shape)

**Interfaces:**
- Consumes: widened `CredentialGroup` fields from Task 3 (arriving via the import report JSON), `CredentialDraft` from `@/lib/credentials/form`.
- Produces: `CredentialPicker` gains optional `draftSeed?: Partial<CredentialDraft>`.

- [ ] **Step 1: Add `draftSeed` to CredentialPicker**

In the props type add `draftSeed?: Partial<CredentialDraft>` (import the type from `@/lib/credentials/form`). Merge it into the create-draft (~:86):

```ts
const startCredentialDraft = {
  ...emptyDraft(),
  name: hostname ? `${hostname} ${TYPE_LABELS[type]}` : `Unnamed ${TYPE_LABELS[type]}`,
  type,
  allowedDomains: hostname,
  ...draftSeed,
}
```

Seeded `headers`/`query` entry rows must keep the trailing blank row convention: when `draftSeed.headers` is provided, append `{ name: '', value: '' }` so the editor's add-row affordance still works (check how `emptyDraft()` initializes them at `src/lib/credentials/form.ts:142-143` and mirror it).

- [ ] **Step 2: Widen the dialog's report type and pass the seed**

In `import-flow-dialog.tsx`, update the local `credentialGroups` array type (~:29-34) to Task 3's widened shape (`credentialType` optional + the new optional fields). In the group render (~:174-190):

- Group label: show `group.sourceDisplayName ?? group.sourceType` (keeps the n8n vendor name visible — this is the "tailored" feel).
- Supported groups: pass to `CredentialPicker`:

```tsx
<CredentialPicker
  type={group.credentialType}
  draftSeed={{
    name: group.sourceDisplayName ? `${group.sourceDisplayName} (imported)` : undefined,
    headerName: group.suggestedHeaderName,
    queryParam: group.suggestedQueryParam,
    headers: group.suggestedEntries?.filter((e) => e.kind === 'header').map((e) => ({ name: e.name, value: '' })),
    query: group.suggestedEntries?.filter((e) => e.kind === 'query').map((e) => ({ name: e.name, value: '' })),
  }}
  ...
/>
```

  Strip `undefined` values from the seed before passing (a `name: undefined` overriding the hostname default would blank it — build the object conditionally).
- Unsupported groups (`group.unsupported` set): render a warning row INSTEAD of the picker: the group name, member step count, and copy `“{displayName} can't be reproduced with a generic credential — n8n authenticates it programmatically. Connect the integration, or open the step and configure auth manually.”` Reuse the dialog's existing warning styling (match how import warnings render elsewhere in this file).

- [ ] **Step 3: Verify the route passes the new fields through**

Read `src/app/api/flows/import/route.ts` ~:320-335: `credentialGroups` is returned from the conversion object as-is. Confirm no re-mapping strips fields (if the route rebuilds the objects field-by-field, add the new fields there). Also confirm `Flow.metadata.importedCredentialGroups` (route.ts ~:223) stores the same objects — it should, unchanged.

- [ ] **Step 4: Typecheck, lint, full test run**

```bash
npm run typecheck && npm run lint
npm test
```

Expected: clean. Fix any fallout in the files this plan touches only.

- [ ] **Step 5: Commit**

```bash
git add src/components/credentials/credential-picker.tsx src/components/flows/import-flow-dialog.tsx src/app/api/flows/import/route.ts
git commit -m "feat(import): tailored credential prefill in the bulk-bind dialog"
```

(Only add `route.ts` if Step 3 changed it.)

---

## Self-review notes

- Spec coverage: generation script (Task 2), checked-in table (Task 2), classifier rules incl. dynamic-name guard (Task 1), importer lookup + fallback + unsupported warning + no-preset-type (Task 3), dialog display-name + prefill + unsupported state (Task 4), table sanity floor (Task 2 test). NANGO exclusion unchanged (Task 3 test).
- Example credential names in Task 2/3 tests (`seatableApi`, `calApi`, `aws`, `notionapi`) must be verified against the actual generated table before finalizing those tests — each test step says so explicitly; the assertions are structural, the vendor names are placeholders for "an entry with this classification."
- Types: `N8nCredentialMapEntry` defined once in Task 1, consumed by Tasks 2–3; `CredentialGroup` widened once in Task 3, consumed by Task 4; `draftSeed` name consistent across Task 4 steps.
