# Implementation Plan — Department-Scoped Template Catalogue

**Date:** 2026-07-12
**Repo:** `/Users/jamesmcdaniel/Den_clone`
**Format:** superpowers writing-plans (TDD, bite-sized, dependency-ordered)

---

## Goal

Ship a static, git-versioned catalogue of **20 curated seed templates** (4 per department × 5 departments), surfaced through the *existing* empty `builtInTemplates` slot in `GET /api/agent-templates`. Every seed — agent **and** flow — is **one-click usable** via a new **flow-provisioning endpoint** that materializes a runnable **DRAFT `Flow`** (graph + any agents) or a runnable agent. Templates are **department-tagged** (multi-valued), **sorted ready-first**, and show a **"Connect to use"** CTA when a required integration is missing — never hidden.

## Architecture

```
                    src/lib/templates/               (NEW — pure, unit-tested)
                    ├── departments.ts   ← departmentsForTools() + canonicalIntegrationSlug() + vocab
                    ├── relevance.ts     ← tierForTemplate() / missingIntegrations() / sortByReadiness()
                    ├── catalogue.ts     ← 20 SeedTemplate entries + serializeSeed()
                    └── provision-plan.ts← rewriteGraphAgentRefs() (pure graph rewrite)
                                 │
        ┌────────────────────────┼───────────────────────────────┬────────────────────┐
        ▼                        ▼                               ▼                    ▼
GET /api/agent-templates   POST /api/templates/provision   templates/page.tsx   templates/[id]/page.tsx
  (serializeTemplate +      (materialize Flow + agents,      (dept filter,        (provision / Connect CTA,
   builtInTemplates =        DRAFT, org-scoped)              Catalogue section,   ready/missing)
   seedCatalogue.map)                                        readiness sort, CTA)
                                 │
                                 ▼
                    src/lib/intelligence/template-from-run.ts
                      (tag auto-templates: configuration.departments = departmentsForTools(integrations))
```

**Data model (zero migration).** Reuse `AgentTemplate.configuration` (Json) and `Flow.graph`/`Flow.trigger` (Json). A seed's `configuration` carries: `departments: string[]`, `requiredIntegrations: string[]`, `recommendedIntegrations: string[]`, `kind: 'agent'|'flow'`, `seed: true`, `seedKey: string`, and — for authoring only, **server-side** — `flowGraph` + `agents`. Seeds are **not DB rows**; they are static objects mapped into `builtInTemplates`.

**Provisioning.** `POST /api/templates/provision { seedKey }` reads the *server-side* catalogue (never trusts a client graph), then:
- `kind:'agent'` → `prisma.agentTask.create` (mirroring `POST /api/agents`) + `syncAgentConnectors` → returns `{ kind:'agent', agentId }`.
- `kind:'flow'` → for each embedded `TemplateAgentSpec`, create an `AgentTask`; rewrite the cloned `flowGraph`'s agent-node `agentId` placeholders → the new agent ids (pure `rewriteGraphAgentRefs`); create a **DRAFT** `Flow` (graph + normalized trigger); returns `{ kind:'flow', flowId }`. UI routes to `/flows/{flowId}` for review + activation.

## Tech Stack

- Next.js App Router route handlers via `withAuthenticatedApi` (`auth.organizationId`, `auth.dbUser.id`).
- Prisma (`prisma.agentTask`, `prisma.flow`), Zod validation, `flowGraphSchema` from `@/lib/flows/graph`.
- Pure logic extracted to `src/lib/templates/*` and tested with `node:test` + `node:assert/strict` under `__tests__/` (repo runner: `npm test` → `tsx --test` over `*__tests__*`).
- Client page is a `'use client'` component; pure relevance helpers are imported directly into the browser bundle.

## Global Constraints

1. **No cross-tenant leak.** Provisioning writes only into `auth.organizationId` scoped by `auth.dbUser.id`. The seed catalogue is static/global and contains **no org data**. `GET /api/agent-templates` keeps its existing `selectVisibleTemplates` cross-org filter (auto-generated rows never leak); seeds are org-neutral `builtIns`.
2. **Existing templates unchanged.** Community authoring (`POST/PUT`), auto-generated distillation, `selectVisibleTemplates`, and the "Your library / Community" sections keep byte-for-byte behavior. New `configuration` keys are **additive & optional**; `serializeTemplate` defaults them.
3. **Relevance never hides.** All 20 seeds always render. Missing-required-integration seeds render a **Connect** CTA and sort *after* ready ones. Sorting/tiering is presentation-only.
4. **Provision is trust-minimized.** The endpoint reads the graph from the server catalogue by `seedKey`; the client sends only `seedKey`. Provisioned flows are **DRAFT** (never auto-activated).
5. **Self-contained seed graphs.** Seed flow graphs reference only (a) embedded agent specs by placeholder ref, and (b) **stable** tool-plane ids: `native:slack`, `native:http` isn't used as a tool id (http is its own node type), `nango:gmail`, `nango:salesforce`. **No per-org MCP/Klavis connection ids appear in any seed graph** (validated by a catalogue test).

---

## File Structure Map

```
src/lib/templates/
  departments.ts                         NEW  taxonomy: DEPARTMENTS, ANCHOR/GLUE, departmentsForTools, canonicalIntegrationSlug
  relevance.ts                           NEW  tierForTemplate, missingIntegrations, sortByReadiness
  catalogue.ts                           NEW  SeedTemplate types + 20 seeds + serializeSeed + getSeedByKey
  provision-plan.ts                      NEW  rewriteGraphAgentRefs (pure graph rewrite)
  __tests__/departments.test.ts          NEW
  __tests__/relevance.test.ts            NEW
  __tests__/catalogue.test.ts            NEW  validates all 20 seeds (unique keys, valid vocab/slugs, schema-valid graphs, agent refs resolve)
  __tests__/provision-plan.test.ts       NEW

src/app/api/agent-templates/route.ts     EDIT templateSchema + serializeTemplate echo new fields; builtInTemplates = seedCatalogue.map(serializeSeed)
src/app/api/templates/provision/route.ts NEW  POST provision (flow + agent), org-scoped, DRAFT flow
src/app/api/templates/provision/__tests__/... (covered by provision-plan.test.ts; route is thin I/O)

src/app/templates/page.tsx               EDIT department filter chips + "Starter catalogue" section + readiness sort + Connect CTA + fetch /api/integrations/available
src/app/templates/[id]/page.tsx          EDIT provision endpoint replaces dead /api/playbooks; ready/missing + Connect CTA; kind-aware routing

src/lib/intelligence/template-from-run.ts EDIT tag auto-templates: configuration.departments = departmentsForTools(integrations)
```

---

## Grounding notes (real code — read before building)

- `src/app/api/agent-templates/route.ts`: `templateSchema` (L6–18), `serializeTemplate` (L20–45) reads from `configuration`, `builtInTemplates: [] ` (L47), GET maps `builtIns` with `{...t, custom:false, mine:false, autoGenerated:false}` and passes to `selectVisibleTemplates(serialized, builtIns)` (L63–67). **Seeds slot straight in here.**
- `src/lib/intelligence/template-visibility.ts`: `selectVisibleTemplates(rows, extraCommunity)` prepends `extraCommunity` ahead of other community rows (L19) → seeds lead the community list.
- `src/lib/flows/graph.ts`: `flowGraphSchema` (L379). **Agent node (`agentNode`, L54–82) requires `agentId: z.string()`** and declares an inline `prompt` (L79) + `model` (L80).
- `src/features/flows/interpret.ts` L15 `RunAgentFn = (node: { id; agentId; input; resume? }) => …` and L321 dispatches `opts.runAgent({ id, agentId: node.data.agentId, input, resume })`. `src/features/flows/execute-flow.ts` L361–364 calls `runAgentExecution({ agentId: node.agentId, … })`. **⇒ inline `prompt` on an agent node is declared but NEVER executed.** Agent nodes MUST carry a real `AgentTask` id → provisioning must materialize agents and rewrite ids. (See "Harder than the design assumed" below.)
- `src/app/api/flows/route.ts` POST (L47–64): `flow.create({ name, description, status, visibility, trigger: jsonValue(trigger), graph: jsonValue(graph), organizationId, userId })`; `status` default `'DRAFT'`; trigger via `normalizeFlowTrigger`/`triggerFromGraph`. `prisma/schema.prisma` `Flow` L670–693 (`status` DRAFT|ACTIVE|DISABLED, `graph` Json, `trigger` Json, `metadata` Json?).
- `src/app/api/agents/route.ts` POST: `prisma.agentTask.create({ data: { type:'agent', agentType:'CUSTOM', priority, description, objective: instructions, context:{}, schedule, status:'ACTIVE', visibility, organizationId, userId, metadata: { title, description, model, integrations, skills, icon, allowSubagents, … } } })` then `await syncAgentConnectors(agent.id, organizationId, integrations)` (`@/lib/connectors/agent-connectors`). **Provision mirrors this to materialize agents.**
- `src/lib/flows/tool-connection-id.ts`: `formatFlowToolConnectionId('nango','salesforce') → 'nango:salesforce'`; `native:<providerId>`; **mcp rows stay RAW (per-org id).** `resolveFlowToolExecutor` (tool-planes.ts L466+): `native` ref ∈ {granola,slack,email,http}; `nango` ref ∈ {slack,gmail,salesforce}. These are the only **stable** ids seed graphs may hardcode.
- `src/lib/nango/delivery.ts` `DELIVERY_TOOLS`: `slack_post_message{channel,text}`, `gmail_send_email{to,subject,body}`, `salesforce_create_record{sobject,fields}`.
- `src/lib/integrations/slack.ts` native tool `post_message{channel,text}`; `src/lib/integrations/http.ts` native tool `request{method,url,headers,body}` (but the flow **`http` node type** is separate and needs no connection).
- `src/lib/connectors/registry.ts` + `src/app/api/integrations/available/route.ts`: connected-slug source. Chip `key`s are mixed-case (`'Slack'`, `'Granola'`, `'HTTP API'`), nango (`'gmail'`,`'salesforce'`,`'slack'`), klavis lowercased agentType (`'github'`,`'hubspot'`,…). `src/components/integrations/integration-chip.tsx` `integrationSlug()` is the substring→logo-slug precedent. **⇒ need `canonicalIntegrationSlug()` to normalize both required slugs and connected chips to one vocabulary.**

---

# Tasks

## Task 1 — Tool→Department taxonomy helper (`departments.ts`)

**Files:** `src/lib/templates/departments.ts` (new), `src/lib/templates/__tests__/departments.test.ts` (new)

**Interfaces:**
```ts
export type Department = 'sales' | 'engineering' | 'marketing' | 'finance' | 'csm' | 'general'
export const DEPARTMENTS: readonly Department[]                 // canonical display order
export function canonicalIntegrationSlug(raw: string): string   // any chip key/label/slug → canonical slug
export function departmentsForTools(slugs: string[]): Department[]
```

**TDD steps:**

1. **RED** — write `__tests__/departments.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { departmentsForTools, canonicalIntegrationSlug, DEPARTMENTS } from '../departments'

test('anchor tools drive their departments; order follows DEPARTMENTS', () => {
  assert.deepEqual(departmentsForTools(['github']), ['engineering'])
  assert.deepEqual(departmentsForTools(['salesforce']), ['sales', 'finance', 'csm'])
  assert.deepEqual(departmentsForTools(['hubspot']), ['sales', 'marketing', 'csm'])
  assert.deepEqual(departmentsForTools(['granola']), ['sales', 'csm'])
  assert.deepEqual(departmentsForTools(['snowflake']), ['finance'])
})

test('multiple anchors union + dedupe in canonical order', () => {
  assert.deepEqual(departmentsForTools(['linear', 'github', 'figma']), ['engineering', 'marketing'])
})

test('glue tools never assign a department alone → general', () => {
  assert.deepEqual(departmentsForTools(['slack', 'gmail', 'notion', 'google_sheets', 'http']), ['general'])
})

test('glue tools contribute nothing when an anchor is present', () => {
  assert.deepEqual(departmentsForTools(['zendesk', 'slack', 'gmail']), ['csm'])
})

test('canonicalIntegrationSlug normalizes chip keys/labels/aliases', () => {
  assert.equal(canonicalIntegrationSlug('Slack'), 'slack')
  assert.equal(canonicalIntegrationSlug('HTTP API'), 'http')
  assert.equal(canonicalIntegrationSlug('Google Sheets'), 'google_sheets')
  assert.equal(canonicalIntegrationSlug('googlesheets'), 'google_sheets')
  assert.equal(canonicalIntegrationSlug('resend'), 'email')
  assert.equal(canonicalIntegrationSlug('mondaydotcom'), 'monday')
  assert.equal(canonicalIntegrationSlug('strata:snowflake'), 'snowflake')
})

test('DEPARTMENTS is the canonical order', () => {
  assert.deepEqual([...DEPARTMENTS], ['sales', 'engineering', 'marketing', 'finance', 'csm', 'general'])
})
```

2. **GREEN** — write `departments.ts`:
```ts
/**
 * Shared tool→department taxonomy. ANCHOR tools imply a department; GLUE tools
 * (slack/gmail/notion/sheets/http/…) never assign one alone. Reused by the
 * seed catalogue (authoring cross-check), relevance sorting, and the BI
 * auto-template tagging in template-from-run.ts. Pure — no I/O.
 */
export type Department = 'sales' | 'engineering' | 'marketing' | 'finance' | 'csm' | 'general'

/** Canonical department display/sort order. */
export const DEPARTMENTS = ['sales', 'engineering', 'marketing', 'finance', 'csm', 'general'] as const

/** Anchor tool (canonical slug) → the departments it implies. */
const ANCHOR_DEPARTMENTS: Record<string, Department[]> = {
  github: ['engineering'],
  linear: ['engineering'],
  jira: ['engineering'],
  confluence: ['engineering'],
  figma: ['engineering', 'marketing'],
  salesforce: ['sales', 'finance', 'csm'],
  hubspot: ['sales', 'marketing', 'csm'],
  zendesk: ['csm'],
  intercom: ['csm'],
  snowflake: ['finance'],
  granola: ['sales', 'csm'],
  monday: ['engineering', 'marketing'],
  asana: ['engineering', 'marketing'],
  clickup: ['engineering', 'marketing'],
  trello: ['engineering', 'marketing'],
}

/** Glue tools — plumbing every department shares; never a department signal alone. */
const GLUE = new Set(['slack', 'gmail', 'email', 'notion', 'google_sheets', 'google_drive', 'google_calendar', 'http'])

/**
 * Normalize any connector chip key / label / logo-slug to the canonical
 * integration vocabulary. Substring precedence mirrors integration-chip's
 * integrationSlug(), but returns the runtime-matchable underscore slug.
 */
export function canonicalIntegrationSlug(raw: string): string {
  const n = raw.toLowerCase().replace(/^strata:/, '').trim()
  if (n.includes('salesforce')) return 'salesforce'
  if (n.includes('slack')) return 'slack'
  if (n.includes('hubspot')) return 'hubspot'
  if (n.includes('snowflake')) return 'snowflake'
  if (n.includes('intercom')) return 'intercom'
  if (n.includes('zendesk')) return 'zendesk'
  if (n.includes('confluence')) return 'confluence'
  if (n.includes('linear')) return 'linear'
  if (n.includes('jira')) return 'jira'
  if (n.includes('github')) return 'github'
  if (n.includes('granola')) return 'granola'
  if (n.includes('asana')) return 'asana'
  if (n.includes('monday')) return 'monday'
  if (n.includes('clickup')) return 'clickup'
  if (n.includes('trello')) return 'trello'
  if (n.includes('figma')) return 'figma'
  if (n.includes('notion')) return 'notion'
  if (n.includes('sheet')) return 'google_sheets'
  if (n.includes('drive')) return 'google_drive'
  if (n.includes('calendar')) return 'google_calendar'
  if (n.includes('gmail') || n.includes('mail')) return 'gmail' // resend "Email" → gmail delivery vocab
  if (n.includes('http')) return 'http'
  return n.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/** Union of departments implied by the given tool slugs; ['general'] when none. */
export function departmentsForTools(slugs: string[]): Department[] {
  const hits = new Set<Department>()
  for (const raw of slugs) {
    const slug = canonicalIntegrationSlug(raw)
    if (GLUE.has(slug)) continue
    for (const dept of ANCHOR_DEPARTMENTS[slug] ?? []) hits.add(dept)
  }
  const ordered = DEPARTMENTS.filter((d): d is Department => d !== 'general' && hits.has(d))
  return ordered.length ? ordered : ['general']
}
```

3. **VERIFY** — `npm test` (departments suite green).

---

## Task 2 — Catalogue with 20 seed templates (`catalogue.ts`)

**Files:** `src/lib/templates/catalogue.ts` (new), `src/lib/templates/__tests__/catalogue.test.ts` (new)
**Depends on:** Task 1.

**Interfaces:**
```ts
export type TemplateAgentSpec = { ref: string; title: string; instructions: string; model?: string; integrations: string[] }
export type SeedTemplate = {
  seedKey: string
  name: string
  description: string
  departments: Department[]
  requiredIntegrations: string[]
  recommendedIntegrations: string[]
  kind: 'agent' | 'flow'
  // agent kind:
  instructions?: string
  model?: string
  integrations?: string[]
  // flow kind:
  agents?: TemplateAgentSpec[]
  flowGraph?: FlowGraph
  trigger?: { type: 'manual' | 'schedule'; [k: string]: unknown }
  icon?: string
  exampleOutput?: string
}
export const SEED_CATALOGUE: SeedTemplate[]
export function getSeedByKey(seedKey: string): SeedTemplate | undefined
export function serializeSeed(seed: SeedTemplate): SerializedTemplate   // GET /api/agent-templates wire shape (no flowGraph/agents)
```

**Design notes for authoring the graphs:**
- Tiny builder helpers keep each graph valid against `flowGraphSchema` and readable.
- **Delivery / writes** use stable tool ids only: Slack via `native:slack`/`post_message`, Salesforce writes via `nango:salesforce`/`salesforce_create_record`, Gmail via `nango:gmail`/`gmail_send_email`. **External enrichment** uses the `http` node type (no connection needed).
- **Every non-native/non-nango system** (github, hubspot, zendesk, linear, confluence, notion, google_sheets, google_drive, snowflake, asana, granola-read) is reached through an **agent node** whose spec `integrations` include that slug — the agent runtime binds those Klavis/MCP planes at run time by selection.
- Agent-node `agentId` holds the spec `ref` placeholder (e.g. `'pr-review'`); provisioning rewrites it (Task 5/6).
- Scheduled flows set `trigger: { type:'schedule', cron, timezone:'UTC' }` and mirror it on the trigger node's `data.trigger`.

**TDD steps:**

1. **RED** — `__tests__/catalogue.test.ts` (this test is the guardrail for all 20 hand-authored entries):
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEED_CATALOGUE, getSeedByKey, serializeSeed } from '../catalogue'
import { flowGraphSchema } from '@/lib/flows/graph'
import { canonicalIntegrationSlug, DEPARTMENTS } from '../departments'

const KNOWN = new Set(DEPARTMENTS)
const STABLE_TOOL_PLANES = new Set(['nango', 'native']) // per-org mcp/klavis ids are forbidden in seed graphs

test('exactly 20 seeds, 4 per department bucket, unique seedKeys', () => {
  assert.equal(SEED_CATALOGUE.length, 20)
  const keys = SEED_CATALOGUE.map((s) => s.seedKey)
  assert.equal(new Set(keys).size, 20, 'seedKeys must be unique')
  for (const dept of DEPARTMENTS.filter((d) => d !== 'general')) {
    const n = SEED_CATALOGUE.filter((s) => s.departments.includes(dept)).length
    assert.ok(n >= 4, `${dept} needs >= 4 seeds, got ${n}`)
  }
})

test('every seed: valid departments, non-empty required∪recommended slugs canonical', () => {
  for (const s of SEED_CATALOGUE) {
    assert.ok(s.departments.length > 0 && s.departments.every((d) => KNOWN.has(d)), s.seedKey)
    for (const slug of [...s.requiredIntegrations, ...s.recommendedIntegrations]) {
      assert.equal(slug, canonicalIntegrationSlug(slug), `${s.seedKey}: ${slug} must already be canonical`)
    }
  }
})

test('agent seeds have instructions; flow seeds have a schema-valid graph', () => {
  for (const s of SEED_CATALOGUE) {
    if (s.kind === 'agent') {
      assert.ok(s.instructions && s.instructions.length > 20, `${s.seedKey} needs instructions`)
    } else {
      assert.ok(s.flowGraph, `${s.seedKey} needs a flowGraph`)
      const parsed = flowGraphSchema.safeParse(s.flowGraph)
      assert.ok(parsed.success, `${s.seedKey} graph invalid: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`)
    }
  }
})

test('flow graphs: every agent node ref resolves to an embedded spec; no per-org connection ids', () => {
  for (const s of SEED_CATALOGUE.filter((x) => x.kind === 'flow')) {
    const refs = new Set((s.agents ?? []).map((a) => a.ref))
    for (const node of s.flowGraph!.nodes) {
      if (node.type === 'agent') {
        assert.ok(refs.has(node.data.agentId), `${s.seedKey}: agent node "${node.data.agentId}" has no spec`)
      }
      if (node.type === 'tool') {
        const [plane] = node.data.connectionId.split(':')
        assert.ok(STABLE_TOOL_PLANES.has(plane), `${s.seedKey}: tool connectionId "${node.data.connectionId}" is not a stable plane`)
      }
    }
  }
})

test('serializeSeed produces the list wire shape (no server-only fields)', () => {
  const wire = serializeSeed(SEED_CATALOGUE[0])
  assert.equal(wire.id, `seed:${SEED_CATALOGUE[0].seedKey}`)
  assert.equal(wire.seed, true)
  assert.equal(wire.custom, false)
  assert.equal(wire.mine, false)
  assert.equal((wire as any).flowGraph, undefined)
  assert.equal((wire as any).agents, undefined)
})

test('getSeedByKey round-trips', () => {
  assert.equal(getSeedByKey(SEED_CATALOGUE[5].seedKey)!.name, SEED_CATALOGUE[5].name)
  assert.equal(getSeedByKey('nope'), undefined)
})
```

2. **GREEN** — `catalogue.ts`. Header + builders + serializer:
```ts
import type { FlowGraph } from '@/lib/flows/graph'
import type { Department } from './departments'

export type TemplateAgentSpec = { ref: string; title: string; instructions: string; model?: string; integrations: string[] }
export type SeedTemplate = {
  seedKey: string; name: string; description: string
  departments: Department[]; requiredIntegrations: string[]; recommendedIntegrations: string[]
  kind: 'agent' | 'flow'
  instructions?: string; model?: string; integrations?: string[]
  agents?: TemplateAgentSpec[]; flowGraph?: FlowGraph
  trigger?: { type: 'manual' | 'schedule'; [k: string]: unknown }
  icon?: string; exampleOutput?: string
}

// ── graph node builders (kept local; output is validated by flowGraphSchema in tests) ──
const trigger = (t: SeedTemplate['trigger'] = { type: 'manual' }) => ({ id: 'trigger', type: 'trigger' as const, data: { trigger: t } })
const agent = (id: string, ref: string, input: string, label: string) => ({ id, type: 'agent' as const, data: { agentId: ref, input, label } })
const httpStep = (id: string, label: string, url: string, method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', body?: string) =>
  ({ id, type: 'http' as const, data: { label, method, url, ...(body ? { body, bodyMode: 'json' as const } : {}) } })
const slackStep = (id: string, channel: string, text: string, label = 'Post to Slack') =>
  ({ id, type: 'tool' as const, data: { label, connectionId: 'native:slack', toolName: 'post_message', args: JSON.stringify({ channel, text }) } })
const sfCreate = (id: string, sobject: string, fields: Record<string, string>, label = 'Create Salesforce record') =>
  ({ id, type: 'tool' as const, data: { label, connectionId: 'nango:salesforce', toolName: 'salesforce_create_record', args: JSON.stringify({ sobject, fields }) } })
const gmailStep = (id: string, to: string, subject: string, bodyTok: string, label = 'Send email') =>
  ({ id, type: 'tool' as const, data: { label, connectionId: 'nango:gmail', toolName: 'gmail_send_email', args: JSON.stringify({ to, subject, body: bodyTok }) } })
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target })
const schedule = (cron: string) => ({ type: 'schedule' as const, cron, timezone: 'UTC' })
```

Then the **20 entries** (author verbatim — real content, not placeholders):

```ts
export const SEED_CATALOGUE: SeedTemplate[] = [
  // ───────────────────────── SALES ─────────────────────────
  {
    seedKey: 'sales-new-lead-to-sf-opportunity',
    name: 'New Lead → Enrich → Salesforce Opportunity',
    description: 'Webhook a new lead in, enrich it from a public company API, draft a qualified opportunity, create it in Salesforce, and announce it in Slack.',
    departments: ['sales'], requiredIntegrations: ['salesforce', 'http'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '🎯',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'lead-qualifier', title: 'Lead Qualifier',
      instructions: 'You qualify inbound leads. Given a raw lead payload and enrichment JSON, decide fit (segment, ICP match, estimated ACV) and produce a concise Opportunity name, amount, and one-paragraph rationale. Reply as JSON with fields: opportunityName, amount, stage, rationale.',
      integrations: ['http'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        httpStep('enrich', 'Enrich company', 'https://api.company-enrich.example/v1/lookup', 'POST', '{"domain":"{{trigger.input}}"}'),
        agent('qualify', 'lead-qualifier', 'Raw lead: {{trigger.input}}\nEnrichment: {{step.enrich.output}}', 'Qualify lead'),
        sfCreate('opp', 'Opportunity', { Name: '{{step.qualify.output.opportunityName}}', Amount: '{{step.qualify.output.amount}}', StageName: '{{step.qualify.output.stage}}' }),
        slackStep('notify', '#sales', 'New opportunity created: *{{step.qualify.output.opportunityName}}* ({{step.qualify.output.amount}}). {{step.qualify.output.rationale}}'),
      ],
      edges: [edge('trigger', 'enrich'), edge('enrich', 'qualify'), edge('qualify', 'opp'), edge('opp', 'notify')],
    },
  },
  {
    seedKey: 'sales-discovery-followup-writer',
    name: 'Discovery Call Follow-up Writer',
    description: 'Pulls the latest Granola discovery notes, drafts a crisp follow-up email with next steps, logs a Salesforce task, and DMs you the draft to send.',
    departments: ['sales'], requiredIntegrations: ['granola', 'salesforce'], recommendedIntegrations: ['gmail', 'slack'],
    kind: 'agent', icon: '✍️', model: 'gpt-4o',
    integrations: ['granola', 'salesforce', 'gmail', 'slack'],
    instructions: 'You are a sales follow-up writer. 1) Read the most recent Granola meeting note for the named account. 2) Draft a follow-up email: thank-you, 3 bullet recap, explicit next steps with dates, and a clear CTA. 3) Create a Salesforce Task capturing the next step and due date. 4) Send the draft to the rep over Slack for a final review before it goes out. Keep the email under 180 words and match the prospect\'s seniority.',
    exampleOutput: 'Subject: Great talking through your rollout timeline\n\nHi Dana — thanks for the time today...\n• Recap: ... • You raised: ... • Next: pilot scoping by Fri.\n(Logged SF Task "Send pilot scope — due 2026-07-15"; draft DM\'d to you.)',
  },
  {
    seedKey: 'sales-pipeline-hygiene-nudger',
    name: 'Pipeline Hygiene Nudger',
    description: 'Every weekday morning, finds stale or past-close-date opportunities in Salesforce and nudges each owner in Slack with exactly what to fix.',
    departments: ['sales'], requiredIntegrations: ['salesforce'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '🔔',
    trigger: schedule('0 13 * * 1-5'),
    agents: [{
      ref: 'hygiene-auditor', title: 'Pipeline Hygiene Auditor',
      instructions: 'Audit open Salesforce opportunities for hygiene problems: missing next step, past close date, no activity in 14+ days, or empty amount. Return a JSON array of { owner, oppName, issue, fixHint } for the worst offenders (max 25).',
      integrations: ['salesforce'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('0 13 * * 1-5')),
        agent('audit', 'hygiene-auditor', 'Audit this org\'s open pipeline for hygiene issues.', 'Audit pipeline'),
        slackStep('nudge', '#sales-ops', ':broom: Pipeline hygiene — {{step.audit.output}} opportunities need attention. Owners, please fix next steps and close dates today.'),
      ],
      edges: [edge('trigger', 'audit'), edge('audit', 'nudge')],
    },
  },
  {
    seedKey: 'sales-weekly-pipeline-digest',
    name: 'Weekly Pipeline Digest → Sheet + Slack',
    description: 'Monday 8am: summarizes HubSpot pipeline movement for the week, appends the snapshot to a Google Sheet, and posts the highlights to Slack.',
    departments: ['sales'], requiredIntegrations: ['hubspot', 'google_sheets'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '📈',
    trigger: schedule('0 12 * * 1'),
    agents: [{
      ref: 'pipeline-analyst', title: 'Pipeline Analyst',
      instructions: 'Summarize this week\'s HubSpot pipeline: new deals, stage advances, slips, and total weighted value vs last week. Append a one-row snapshot to the tracking Google Sheet, and produce a 5-bullet Slack-ready highlight summary. Reply with the highlight text.',
      integrations: ['hubspot', 'google_sheets'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('0 12 * * 1')),
        agent('analyze', 'pipeline-analyst', 'Produce this week\'s pipeline digest and append the snapshot to the tracking sheet.', 'Analyze pipeline'),
        slackStep('post', '#sales', ':bar_chart: *Weekly pipeline digest*\n{{step.analyze.output}}'),
      ],
      edges: [edge('trigger', 'analyze'), edge('analyze', 'post')],
    },
  },

  // ───────────────────────── ENGINEERING ─────────────────────────
  {
    seedKey: 'eng-pr-review-checklist-bot',
    name: 'PR Review Checklist Bot',
    description: 'On a PR-ready webhook, reviews the diff against a quality checklist (tests, types, migrations, docs) and posts a structured review summary to Slack.',
    departments: ['engineering'], requiredIntegrations: ['github'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '✅',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'pr-reviewer', title: 'PR Review Checklist Bot',
      instructions: 'Given a GitHub pull request reference, fetch the diff and files changed. Evaluate against: tests added/updated, type safety, DB migration safety, breaking changes, docs. Return a JSON object { verdict, blockers[], nits[], summary } where verdict ∈ approve|comment|request_changes.',
      integrations: ['github'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        agent('review', 'pr-reviewer', 'Review PR: {{trigger.input}}', 'Review PR'),
        slackStep('post', '#eng-reviews', ':white_check_mark: PR review ({{step.review.output.verdict}})\n{{step.review.output.summary}}'),
      ],
      edges: [edge('trigger', 'review'), edge('review', 'post')],
    },
  },
  {
    seedKey: 'eng-issue-triage-routing',
    name: 'Issue Triage & Routing Agent',
    description: 'Reads a new GitHub issue, classifies severity and area, files or links a Linear ticket to the right team, and pings the on-call channel when it is urgent.',
    departments: ['engineering'], requiredIntegrations: ['github', 'linear'], recommendedIntegrations: ['slack'],
    kind: 'agent', icon: '🧭', model: 'gpt-4o',
    integrations: ['github', 'linear', 'slack'],
    instructions: 'You triage incoming engineering issues. 1) Read the GitHub issue. 2) Classify: severity (P0–P3), area/team, and a one-line reproduction summary. 3) Create a Linear issue on the owning team with labels and the summary, or link an existing duplicate. 4) If P0/P1, post to #eng-oncall with the Linear link. Be conservative about severity and always cite the signal that set it.',
    exampleOutput: 'Triaged #4821 → P1, Billing. Linear BIL-233 created (labels: bug, p1). Posted to #eng-oncall: "P1 billing: refunds double-charging on retry."',
  },
  {
    seedKey: 'eng-release-notes-drafter',
    name: 'Release Notes Drafter',
    description: 'Collates merged GitHub PRs and closed Linear issues since the last release, drafts human-readable release notes, publishes them to Confluence, and shares the link in Slack.',
    departments: ['engineering'], requiredIntegrations: ['github', 'linear', 'confluence'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '📝',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'notes-collator', title: 'Release Notes Collator',
      instructions: 'Given a release range (tag or date), gather merged GitHub PRs and closed Linear issues. Group into Features / Fixes / Internal. Write concise, user-facing release notes in Markdown. Reply with the Markdown body.',
      integrations: ['github', 'linear'],
    }, {
      ref: 'notes-publisher', title: 'Confluence Publisher',
      instructions: 'Publish the provided release-notes Markdown as a new Confluence page under the Releases space, titled with today\'s date. Reply with the published page URL.',
      integrations: ['confluence'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        agent('collate', 'notes-collator', 'Draft release notes for range: {{trigger.input}}', 'Collate notes'),
        agent('publish', 'notes-publisher', 'Publish these release notes to Confluence:\n{{step.collate.output}}', 'Publish to Confluence'),
        slackStep('share', '#engineering', ':memo: Release notes published: {{step.publish.output}}'),
      ],
      edges: [edge('trigger', 'collate'), edge('collate', 'publish'), edge('publish', 'share')],
    },
  },
  {
    seedKey: 'eng-sprint-standup-digest',
    name: 'Sprint Standup Digest',
    description: 'Each weekday, summarizes Linear board movement (done, in-progress, blocked) into a tight standup digest and posts it to the team Slack channel.',
    departments: ['engineering'], requiredIntegrations: ['linear'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '☀️',
    trigger: schedule('30 13 * * 1-5'),
    agents: [{
      ref: 'standup-writer', title: 'Standup Digest Writer',
      instructions: 'Summarize the active Linear sprint since yesterday: what shipped, what is in progress, and what is blocked (with blocker + owner). Keep it to 8 bullets max, Slack mrkdwn. Reply with the digest text.',
      integrations: ['linear'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('30 13 * * 1-5')),
        agent('digest', 'standup-writer', 'Write today\'s standup digest from the active sprint.', 'Write standup'),
        slackStep('post', '#eng-standup', ':sunny: *Standup digest*\n{{step.digest.output}}'),
      ],
      edges: [edge('trigger', 'digest'), edge('digest', 'post')],
    },
  },

  // ───────────────────────── MARKETING ─────────────────────────
  {
    seedKey: 'mkt-inbound-mql-router',
    name: 'Inbound MQL Router',
    description: 'On a form-fill webhook, scores the lead against ICP, upserts it to HubSpot with the score, and routes hot MQLs to the right AE in Slack.',
    departments: ['marketing'], requiredIntegrations: ['hubspot', 'http'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '🧲',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'mql-scorer', title: 'MQL Scorer',
      instructions: 'Score an inbound marketing lead against ICP using the form payload and any enrichment. Return JSON { score (0-100), tier (hot|warm|cold), assignedTeam, reason }. Upsert the contact + score into HubSpot.',
      integrations: ['hubspot', 'http'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        httpStep('enrich', 'Enrich lead', 'https://api.company-enrich.example/v1/lookup', 'POST', '{"email":"{{trigger.input}}"}'),
        agent('score', 'mql-scorer', 'Lead: {{trigger.input}}\nEnrichment: {{step.enrich.output}}', 'Score MQL'),
        slackStep('route', '#mkt-to-sales', ':magnet: New {{step.score.output.tier}} MQL (score {{step.score.output.score}}) → {{step.score.output.assignedTeam}}. {{step.score.output.reason}}'),
      ],
      edges: [edge('trigger', 'enrich'), edge('enrich', 'score'), edge('score', 'route')],
    },
  },
  {
    seedKey: 'mkt-campaign-brief-to-calendar',
    name: 'Campaign Brief → Content Calendar',
    description: 'Turns a one-line campaign goal into a structured brief and a two-week content calendar in Notion, with assets outlined in a linked Google Drive doc.',
    departments: ['marketing'], requiredIntegrations: ['notion', 'google_drive'], recommendedIntegrations: [],
    kind: 'agent', icon: '🗓️', model: 'gpt-4o',
    integrations: ['notion', 'google_drive'],
    instructions: 'You are a campaign planner. From a short campaign goal: 1) Write a crisp brief (audience, message, channels, KPIs). 2) Build a 2-week content calendar in Notion (date, channel, format, hook, owner). 3) Create a linked Google Drive doc outlining each asset. Keep hooks specific and channel-appropriate; do not invent metrics — mark KPIs as targets to confirm.',
    exampleOutput: 'Brief: "Launch self-serve tier to PLG signups"... Calendar (Notion): Mon LinkedIn teaser, Tue blog "3 ways...", Thu launch email... Assets doc: /Drive/Campaigns/self-serve.',
  },
  {
    seedKey: 'mkt-weekly-performance-digest',
    name: 'Weekly Marketing Performance Digest',
    description: 'Monday morning: rolls up HubSpot campaign and funnel metrics for the week, appends them to a Google Sheet, and posts a highlights digest to Slack.',
    departments: ['marketing'], requiredIntegrations: ['hubspot', 'google_sheets'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '📊',
    trigger: schedule('0 13 * * 1'),
    agents: [{
      ref: 'mkt-analyst', title: 'Marketing Performance Analyst',
      instructions: 'Summarize this week\'s HubSpot marketing performance: MQLs, conversion rate by source, top campaigns, and week-over-week deltas. Append a snapshot row to the metrics Google Sheet. Reply with a 6-bullet Slack highlight.',
      integrations: ['hubspot', 'google_sheets'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('0 13 * * 1')),
        agent('analyze', 'mkt-analyst', 'Produce this week\'s marketing performance digest and append the snapshot.', 'Analyze performance'),
        slackStep('post', '#marketing', ':chart_with_upwards_trend: *Weekly marketing digest*\n{{step.analyze.output}}'),
      ],
      edges: [edge('trigger', 'analyze'), edge('analyze', 'post')],
    },
  },
  {
    seedKey: 'mkt-content-repurposer',
    name: 'Content Repurposer',
    description: 'Takes a published piece from Notion or Drive and spins it into a LinkedIn post, an X thread, and a newsletter blurb, then emails you the pack.',
    departments: ['marketing'], requiredIntegrations: ['notion', 'google_drive'], recommendedIntegrations: ['gmail'],
    kind: 'agent', icon: '♻️', model: 'gpt-4o',
    integrations: ['notion', 'google_drive', 'gmail'],
    instructions: 'You repurpose long-form content. Read the source doc (Notion page or Drive doc). Produce: 1) a LinkedIn post (hook + 3 insights + CTA), 2) a 5-tweet X thread, 3) a 60-word newsletter blurb. Preserve the original\'s claims and voice; no new stats. Email the finished pack to the requester.',
    exampleOutput: 'LinkedIn: "We cut onboarding time 40%. Here\'s how →"... X thread (1/5)... Newsletter: "This week we shipped..." (emailed to you).',
  },

  // ───────────────────────── FINANCE ─────────────────────────
  {
    seedKey: 'fin-revenue-snapshot-variance-alert',
    name: 'Revenue Snapshot & Variance Alert',
    description: 'Daily: compares closed-won revenue in Salesforce against plan in a Google Sheet and alerts Slack when variance breaches threshold.',
    departments: ['finance'], requiredIntegrations: ['salesforce', 'google_sheets'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '💰',
    trigger: schedule('0 14 * * 1-5'),
    agents: [{
      ref: 'variance-analyst', title: 'Revenue Variance Analyst',
      instructions: 'Read closed-won revenue MTD/QTD from Salesforce and the plan targets from the finance Google Sheet. Compute variance (absolute + %). Return JSON { periodRevenue, planTarget, variancePct, breach (boolean), commentary }. Breach when |variancePct| >= 10.',
      integrations: ['salesforce', 'google_sheets'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('0 14 * * 1-5')),
        agent('analyze', 'variance-analyst', 'Compute today\'s revenue-vs-plan variance.', 'Analyze variance'),
        {
          id: 'gate', type: 'filter' as const,
          data: { label: 'Only alert on breach', match: 'all' as const, clauses: [{ left: '{{step.analyze.output.breach}}', op: 'eq' as const, right: 'true' }] },
        },
        slackStep('alert', '#finance', ':rotating_light: Revenue variance {{step.analyze.output.variancePct}}% vs plan. {{step.analyze.output.commentary}}'),
      ],
      edges: [edge('trigger', 'analyze'), edge('analyze', 'gate'), edge('gate', 'alert')],
    },
  },
  {
    seedKey: 'fin-new-deal-billing-handoff',
    name: 'New Deal → Billing Handoff',
    description: 'On a closed-won signal, assembles the billing packet from Salesforce, records it to a Google Sheet, opens the billing system record via API, and notifies finance in Slack.',
    departments: ['finance'], requiredIntegrations: ['salesforce', 'http', 'google_sheets'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '🧾',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'billing-packet', title: 'Billing Packet Assembler',
      instructions: 'For a closed-won Salesforce opportunity, assemble the billing packet: account, contract value, term, billing contact, start date, and PO if present. Append the packet to the billing Google Sheet. Return JSON { account, amount, term, billingEmail, startDate }.',
      integrations: ['salesforce', 'google_sheets'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        agent('assemble', 'billing-packet', 'Assemble the billing packet for opportunity: {{trigger.input}}', 'Assemble packet'),
        httpStep('billing', 'Create billing record', 'https://api.billing.example/v1/invoices', 'POST', '{"account":"{{step.assemble.output.account}}","amount":"{{step.assemble.output.amount}}","startDate":"{{step.assemble.output.startDate}}"}'),
        slackStep('notify', '#finance', ':receipt: Billing handoff ready for *{{step.assemble.output.account}}* ({{step.assemble.output.amount}}). Record: {{step.billing.output}}'),
      ],
      edges: [edge('trigger', 'assemble'), edge('assemble', 'billing'), edge('billing', 'notify')],
    },
  },
  {
    seedKey: 'fin-spend-anomaly-reporter',
    name: 'Spend & Expense Anomaly Reporter',
    description: 'Weekly: scans an expense/spend Google Sheet for outliers and policy breaches, then emails finance a ranked anomaly report.',
    departments: ['finance'], requiredIntegrations: ['google_sheets'], recommendedIntegrations: ['gmail'],
    kind: 'agent', icon: '🚩', model: 'gpt-4o',
    integrations: ['google_sheets', 'gmail'],
    instructions: 'You are an expense auditor. Read the spend/expense Google Sheet. Flag anomalies: amounts >3x category median, duplicate charges, missing receipts, out-of-policy categories. Rank by risk. Email finance a report with a ranked table and a one-line recommendation per item. Never approve or reject — only surface.',
    exampleOutput: 'Top anomalies: 1) $4,200 "Software" (7x median, no receipt) 2) Duplicate $980 travel charge 3) ... (emailed to finance@).',
  },
  {
    seedKey: 'fin-weekly-cash-ar-digest',
    name: 'Weekly Cash & AR Digest',
    description: 'Monday: queries Snowflake for cash position and AR aging, snapshots it to a Google Sheet, and posts a leadership-ready digest to Slack.',
    departments: ['finance'], requiredIntegrations: ['snowflake', 'google_sheets'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '🏦',
    trigger: schedule('0 13 * * 1'),
    agents: [{
      ref: 'cash-analyst', title: 'Cash & AR Analyst',
      instructions: 'Query Snowflake for current cash position, AR aging buckets (0-30/31-60/61-90/90+), and DSO. Append a snapshot row to the finance Google Sheet. Return a 5-bullet Slack digest highlighting overdue accounts and DSO trend.',
      integrations: ['snowflake', 'google_sheets'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('0 13 * * 1')),
        agent('analyze', 'cash-analyst', 'Produce this week\'s cash & AR digest and append the snapshot.', 'Analyze cash & AR'),
        slackStep('post', '#finance-leadership', ':bank: *Weekly cash & AR digest*\n{{step.analyze.output}}'),
      ],
      edges: [edge('trigger', 'analyze'), edge('analyze', 'post')],
    },
  },

  // ───────────────────────── CSM ─────────────────────────
  {
    seedKey: 'csm-ticket-triage-escalation',
    name: 'Support Ticket Triage & Escalation',
    description: 'On a new Zendesk ticket, classifies urgency and sentiment, drafts a first response, and escalates angry or high-severity tickets to Slack.',
    departments: ['csm'], requiredIntegrations: ['zendesk'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '🎫',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'ticket-triager', title: 'Support Ticket Triager',
      instructions: 'Read a Zendesk ticket. Return JSON { priority (urgent|high|normal|low), sentiment (angry|frustrated|neutral|happy), category, draftReply, escalate (boolean) }. Set escalate=true for urgent priority OR angry sentiment. Keep draftReply empathetic and specific.',
      integrations: ['zendesk'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        agent('triage', 'ticket-triager', 'Triage Zendesk ticket: {{trigger.input}}', 'Triage ticket'),
        {
          id: 'gate', type: 'filter' as const,
          data: { label: 'Escalate only when flagged', match: 'all' as const, clauses: [{ left: '{{step.triage.output.escalate}}', op: 'eq' as const, right: 'true' }] },
        },
        slackStep('escalate', '#support-escalations', ':ticket: {{step.triage.output.priority}}/{{step.triage.output.sentiment}} ticket needs eyes: {{trigger.input}}'),
      ],
      edges: [edge('trigger', 'triage'), edge('triage', 'gate'), edge('gate', 'escalate')],
    },
  },
  {
    seedKey: 'csm-churn-risk-early-warning',
    name: 'Churn-Risk Early Warning',
    description: 'Daily: cross-references Zendesk ticket trends and Salesforce account health signals to flag at-risk accounts and alerts the CSM team in Slack.',
    departments: ['csm'], requiredIntegrations: ['zendesk', 'salesforce'], recommendedIntegrations: ['slack'],
    kind: 'flow', icon: '⚠️',
    trigger: schedule('0 14 * * 1-5'),
    agents: [{
      ref: 'churn-scorer', title: 'Churn Risk Scorer',
      instructions: 'Combine Zendesk signals (ticket volume spike, negative sentiment, unresolved escalations) with Salesforce account health (usage drop, renewal date proximity, exec sponsor change). Return a JSON array of { account, riskScore (0-100), topSignals[], recommendedPlay } for accounts scoring >= 60, max 15.',
      integrations: ['zendesk', 'salesforce'],
    }],
    flowGraph: {
      nodes: [
        trigger(schedule('0 14 * * 1-5')),
        agent('score', 'churn-scorer', 'Score accounts for churn risk today.', 'Score churn risk'),
        slackStep('alert', '#csm', ':warning: *Churn early-warning* — at-risk accounts:\n{{step.score.output}}'),
      ],
      edges: [edge('trigger', 'score'), edge('score', 'alert')],
    },
  },
  {
    seedKey: 'csm-qbr-prep-brief',
    name: 'QBR Prep Brief',
    description: 'Assembles a QBR brief for an account: support history from Zendesk, commercial context from Salesforce, recent Granola call notes, all written up in Notion.',
    departments: ['csm'], requiredIntegrations: ['zendesk', 'salesforce', 'granola'], recommendedIntegrations: ['notion'],
    kind: 'agent', icon: '📋', model: 'gpt-4o',
    integrations: ['zendesk', 'salesforce', 'granola', 'notion'],
    instructions: 'You prepare Quarterly Business Review briefs. For a named account: 1) Pull Salesforce commercials (ARR, renewal date, expansion pipeline). 2) Summarize Zendesk support trends (volume, CSAT, recurring issues). 3) Read recent Granola call notes for stated goals and objections. 4) Write a QBR brief in Notion: wins, risks, adoption, expansion opportunities, and 3 recommended talking points. Cite specifics; flag anything that needs the CSM to verify.',
    exampleOutput: 'QBR — Acme Corp: ARR $180k, renewal 2026-09. Wins: 3 new teams onboarded. Risks: 2 open P1s, CSAT dip. Expansion: analytics add-on. Talking points: ... (written to Notion).',
  },
  {
    seedKey: 'csm-onboarding-task-orchestrator',
    name: 'Onboarding Task Orchestrator',
    description: 'On a new closed-won signal, spins up the onboarding plan in Asana from the Salesforce deal, emails the customer a kickoff, and posts the plan to Slack.',
    departments: ['csm'], requiredIntegrations: ['salesforce', 'asana'], recommendedIntegrations: ['gmail', 'slack'],
    kind: 'flow', icon: '🚀',
    trigger: { type: 'manual' },
    agents: [{
      ref: 'onboarding-planner', title: 'Onboarding Planner',
      instructions: 'For a newly closed Salesforce deal, read the account and product mix, then create an Asana onboarding project with milestone tasks (kickoff, provisioning, training, go-live) assigned by role with due dates. Return JSON { account, kickoffEmailBody, planSummary, customerEmail }.',
      integrations: ['salesforce', 'asana'],
    }],
    flowGraph: {
      nodes: [
        trigger(),
        agent('plan', 'onboarding-planner', 'Build the onboarding plan for deal: {{trigger.input}}', 'Build onboarding plan'),
        gmailStep('kickoff', '{{step.plan.output.customerEmail}}', 'Welcome aboard — your onboarding plan', '{{step.plan.output.kickoffEmailBody}}'),
        slackStep('post', '#customer-success', ':rocket: Onboarding kicked off for *{{step.plan.output.account}}*.\n{{step.plan.output.planSummary}}'),
      ],
      edges: [edge('trigger', 'plan'), edge('plan', 'kickoff'), edge('kickoff', 'post')],
    },
  },
]

export function getSeedByKey(seedKey: string): SeedTemplate | undefined {
  return SEED_CATALOGUE.find((s) => s.seedKey === seedKey)
}
```

3. **GREEN (cont.)** — `serializeSeed` returns the SAME wire shape as `serializeTemplate` plus the additive fields, **omitting** `flowGraph`/`agents` (server-only):
```ts
export type SerializedTemplate = ReturnType<typeof serializeSeed>
export function serializeSeed(seed: SeedTemplate) {
  const integrations = Array.from(new Set([...seed.requiredIntegrations, ...seed.recommendedIntegrations]))
  return {
    id: `seed:${seed.seedKey}`,
    name: seed.name,
    description: seed.description,
    category: seed.departments[0] ?? 'general',
    instructions: seed.instructions ?? seed.description,
    integrations,
    skills: [] as string[],
    tags: seed.departments as string[],
    model: seed.model ?? 'gpt-4o',
    exampleOutput: seed.exampleOutput ?? '',
    icon: seed.icon ?? '',
    allowSubagents: false,
    custom: false,
    authorName: 'Sublime',
    mine: false,
    autoGenerated: false,
    // additive catalogue fields (also echoed by serializeTemplate for DB rows):
    departments: seed.departments as string[],
    requiredIntegrations: seed.requiredIntegrations,
    recommendedIntegrations: seed.recommendedIntegrations,
    kind: seed.kind,
    seed: true as const,
    seedKey: seed.seedKey,
  }
}
```

4. **VERIFY** — `npm test` (catalogue suite green ⇒ all 20 graphs pass `flowGraphSchema`, refs resolve, slugs canonical, no per-org ids).

> Note: `filter` node clauses compare a resolved token string to `'true'`. Confirm during build that agent JSON output booleans stringify to `'true'`/`'false'` in the datatree; if not, switch the gate to a `condition` node or have the agent emit a string `"yes"`. The catalogue test will not catch this — it is a runtime concern flagged for the executing session to verify against `src/lib/flows/datatree.ts`.

---

## Task 3 — Schema + serializer + builtIns wiring (`agent-templates/route.ts`)

**Files:** `src/app/api/agent-templates/route.ts` (edit). No new test file — behavior is covered by the existing `template-visibility` test plus a small addition here.

**Interfaces:** extend `templateSchema` and `serializeTemplate`; populate `builtInTemplates` from the catalogue.

**TDD steps:**

1. **RED** — add a case to `src/lib/intelligence/__tests__/template-visibility.test.ts` asserting seeds (as `extraCommunity`) lead the community section and never displace `mine`:
```ts
test('seed builtIns lead the community section, after mine', () => {
  const rows = [{ id: 'mine', mine: true, autoGenerated: false }, { id: 'community', mine: false, autoGenerated: false }]
  const seeds = [{ id: 'seed:x', mine: false, autoGenerated: false }]
  const out = selectVisibleTemplates(rows as any, seeds as any).map((t: any) => t.id)
  assert.deepEqual(out, ['mine', 'seed:x', 'community'])
})
```

2. **GREEN** — edit the route:
   - Extend `templateSchema` (additive, all optional):
```ts
const templateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  category: z.string().default('Custom'),
  instructions: z.string().min(1),
  integrations: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  model: z.string().default('gpt-4o'),
  exampleOutput: z.string().optional(),
  icon: z.string().trim().max(8).optional(),
  allowSubagents: z.boolean().optional(),
  // department-catalogue metadata (additive; community authoring may omit all):
  departments: z.array(z.string()).optional(),
  requiredIntegrations: z.array(z.string()).optional(),
  recommendedIntegrations: z.array(z.string()).optional(),
  kind: z.enum(['agent', 'flow']).optional(),
})
```
   - In `serializeTemplate`, echo the additive fields from `config` (defaults keep existing rows unchanged), and mark non-seed DB rows `seed: false`:
```ts
    departments: Array.isArray(config.departments) ? config.departments : [],
    requiredIntegrations: Array.isArray(config.requiredIntegrations) ? config.requiredIntegrations : [],
    recommendedIntegrations: Array.isArray(config.recommendedIntegrations) ? config.recommendedIntegrations : [],
    kind: config.kind === 'flow' ? 'flow' : 'agent',
    seed: false,
    seedKey: typeof config.seedKey === 'string' ? config.seedKey : '',
```
   - In `POST`, persist the new keys into `configuration` when present (additive spreads next to `authorName`):
```ts
        ...(data.departments ? { departments: data.departments } : {}),
        ...(data.requiredIntegrations ? { requiredIntegrations: data.requiredIntegrations } : {}),
        ...(data.recommendedIntegrations ? { recommendedIntegrations: data.recommendedIntegrations } : {}),
        ...(data.kind ? { kind: data.kind } : {}),
```
   - Replace `const builtInTemplates: Array<Record<string, unknown>> = []` with:
```ts
import { SEED_CATALOGUE, serializeSeed } from '@/lib/templates/catalogue'
const builtInTemplates = SEED_CATALOGUE.map(serializeSeed)
```
   The existing GET line `builtInTemplates.map((t) => ({ ...t, custom: false, mine: false, autoGenerated: false }))` and `selectVisibleTemplates(serialized, builtIns)` are unchanged — seeds now flow through as `extraCommunity`.

3. **VERIFY** — `npm test`; then `npx tsc --noEmit` (route type check — recall `selectVisibleTemplates` lives outside the route module precisely to satisfy the route's generated type check; do not add non-handler exports to `route.ts`).

---

## Task 4 — Relevance tiering (`relevance.ts`)

**Files:** `src/lib/templates/relevance.ts` (new), `src/lib/templates/__tests__/relevance.test.ts` (new)
**Depends on:** Task 1 (`canonicalIntegrationSlug`).

**Interfaces:**
```ts
export type Tier = 'ready' | 'connect'
export function missingIntegrations(required: string[], connected: Iterable<string>): string[]
export function tierForTemplate(required: string[], connected: Iterable<string>): Tier
export function connectedSlugSet(tools: { key?: string; label?: string; slug?: string; connected: boolean }[]): Set<string>
export function sortByReadiness<T extends { requiredIntegrations: string[] }>(items: T[], connected: Iterable<string>): T[]
```

**TDD steps:**

1. **RED** — `__tests__/relevance.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingIntegrations, tierForTemplate, connectedSlugSet, sortByReadiness } from '../relevance'

test('ready when all required are connected (or none required)', () => {
  const connected = new Set(['salesforce', 'slack'])
  assert.equal(tierForTemplate(['salesforce'], connected), 'ready')
  assert.equal(tierForTemplate([], connected), 'ready')
  assert.equal(tierForTemplate(['github'], connected), 'connect')
})

test('missingIntegrations returns only the unmet required slugs (canonicalized both sides)', () => {
  assert.deepEqual(missingIntegrations(['github', 'slack'], new Set(['Slack'])), ['github'])
})

test('connectedSlugSet canonicalizes available-tools chips and drops disconnected', () => {
  const set = connectedSlugSet([
    { key: 'Slack', connected: true },
    { key: 'HTTP API', connected: true },
    { label: 'GitHub', connected: false },
  ])
  assert.ok(set.has('slack') && set.has('http'))
  assert.ok(!set.has('github'))
})

test('sortByReadiness is stable and NEVER drops items (ready first)', () => {
  const items = [
    { seedKey: 'a', requiredIntegrations: ['github'] },
    { seedKey: 'b', requiredIntegrations: [] },
    { seedKey: 'c', requiredIntegrations: ['github'] },
    { seedKey: 'd', requiredIntegrations: [] },
  ]
  const out = sortByReadiness(items, new Set<string>()).map((i) => i.seedKey)
  assert.deepEqual(out, ['b', 'd', 'a', 'c'])
  assert.equal(out.length, items.length)
})
```

2. **GREEN** — `relevance.ts`:
```ts
import { canonicalIntegrationSlug } from './departments'

export type Tier = 'ready' | 'connect'

export function missingIntegrations(required: string[], connected: Iterable<string>): string[] {
  const have = new Set([...connected].map(canonicalIntegrationSlug))
  return required.map(canonicalIntegrationSlug).filter((slug) => !have.has(slug))
}

export function tierForTemplate(required: string[], connected: Iterable<string>): Tier {
  return missingIntegrations(required, connected).length === 0 ? 'ready' : 'connect'
}

/** Available-tools chips (GET /api/integrations/available) → canonical connected slug set. */
export function connectedSlugSet(tools: { key?: string; label?: string; slug?: string; connected: boolean }[]): Set<string> {
  const set = new Set<string>()
  for (const t of tools) {
    if (!t.connected) continue
    set.add(canonicalIntegrationSlug(t.key ?? t.slug ?? t.label ?? ''))
  }
  return set
}

/** Stable sort: ready templates first, never removing any. Presentation-only. */
export function sortByReadiness<T extends { requiredIntegrations: string[] }>(items: T[], connected: Iterable<string>): T[] {
  const have = new Set([...connected].map(canonicalIntegrationSlug))
  const ready = (t: T) => t.requiredIntegrations.map(canonicalIntegrationSlug).every((s) => have.has(s))
  return [...items].sort((a, b) => Number(ready(b)) - Number(ready(a)))
}
```

3. **VERIFY** — `npm test`.

---

## Task 5 — Provision plan pure helper (`provision-plan.ts`)

**Files:** `src/lib/templates/provision-plan.ts` (new), `src/lib/templates/__tests__/provision-plan.test.ts` (new)
**Depends on:** Task 2.

**Interface:**
```ts
export function rewriteGraphAgentRefs(graph: FlowGraph, refToId: Record<string, string>): FlowGraph
```
Pure deep-rewrite: returns a new graph where every `agent` node's `data.agentId` that matches a key in `refToId` is replaced with the materialized id; throws if an agent node references an unknown ref (authoring/materialization mismatch).

**TDD steps:**

1. **RED** — `__tests__/provision-plan.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteGraphAgentRefs } from '../provision-plan'
import type { FlowGraph } from '@/lib/flows/graph'

const g: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'a', type: 'agent', data: { agentId: 'ref-one', input: 'x' } },
    { id: 't', type: 'tool', data: { connectionId: 'native:slack', toolName: 'post_message', args: '{}' } },
  ],
  edges: [{ id: 'e', source: 'trigger', target: 'a' }],
}

test('rewrites matching agent refs, leaves other nodes untouched, does not mutate input', () => {
  const out = rewriteGraphAgentRefs(g, { 'ref-one': 'agent_123' })
  const agent = out.nodes.find((n) => n.id === 'a')!
  assert.equal((agent as any).data.agentId, 'agent_123')
  assert.equal((g.nodes[1] as any).data.agentId, 'ref-one', 'input graph unchanged')
  assert.equal((out.nodes.find((n) => n.id === 't') as any).data.toolName, 'post_message')
})

test('throws on an unresolved agent ref', () => {
  assert.throws(() => rewriteGraphAgentRefs(g, {}), /unresolved agent/i)
})
```

2. **GREEN** — `provision-plan.ts`:
```ts
import type { FlowGraph } from '@/lib/flows/graph'

/**
 * Return a deep copy of `graph` with every agent node's placeholder `agentId`
 * (a TemplateAgentSpec.ref) replaced by the materialized AgentTask id from
 * `refToId`. Throws when a ref has no mapping — a real AgentTask id is
 * mandatory because the flow interpreter executes agent nodes purely by
 * `data.agentId` (inline prompts are not executed; see interpret.ts L321).
 */
export function rewriteGraphAgentRefs(graph: FlowGraph, refToId: Record<string, string>): FlowGraph {
  const clone: FlowGraph = JSON.parse(JSON.stringify(graph))
  for (const node of clone.nodes) {
    if (node.type !== 'agent') continue
    const id = refToId[node.data.agentId]
    if (!id) throw new Error(`unresolved agent ref "${node.data.agentId}" — no materialized agent`)
    node.data.agentId = id
  }
  return clone
}
```

3. **VERIFY** — `npm test`.

---

## Task 6 — Flow-provisioning endpoint (`POST /api/templates/provision`)

**Files:** `src/app/api/templates/provision/route.ts` (new)
**Depends on:** Tasks 2, 5.

**Endpoint shape:**
```
POST /api/templates/provision
Body:  { seedKey: string }
Resp:  { success: true, kind: 'flow', flowId }  |  { success: true, kind: 'agent', agentId }
Errors: 404 SEED_NOT_FOUND
```

**Behavior (org-scoped, DRAFT flow):**
- Reads the seed from the **server-side** catalogue (`getSeedByKey`) — the client graph is never trusted.
- `kind:'agent'`: `materializeAgent(seed → AgentTask)` + `syncAgentConnectors`; return `{ kind:'agent', agentId }`.
- `kind:'flow'`:
  1. Materialize one `AgentTask` per `TemplateAgentSpec` (record `ref → id`).
  2. `rewriteGraphAgentRefs(seed.flowGraph, refToId)`.
  3. Normalize the trigger (`normalizeFlowTrigger(seed.trigger)` else `triggerFromGraph(graph)`).
  4. `prisma.flow.create({ status:'DRAFT', graph, trigger, metadata:{ seededFrom: seed.seedKey }, organizationId, userId })`.
  5. `syncAgentConnectors` for each created agent (post-create, best-effort — mirrors the agents route).
  6. Return `{ kind:'flow', flowId }`.

**Implementation (mirrors `agents` POST create + `flows` POST create):**
```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { getSeedByKey, type SeedTemplate, type TemplateAgentSpec } from '@/lib/templates/catalogue'
import { rewriteGraphAgentRefs } from '@/lib/templates/provision-plan'
import { normalizeFlowTrigger, triggerFromGraph } from '@/lib/flows/trigger'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'

const body = z.object({ seedKey: z.string().min(1) })
const jsonValue = (v: unknown) => JSON.parse(JSON.stringify(v ?? null))

/** Create one AgentTask mirroring POST /api/agents' create shape. */
async function materializeAgent(
  spec: { title: string; instructions: string; model?: string; integrations: string[] },
  organizationId: string,
  userId: string,
): Promise<string> {
  const agent = await prisma.agentTask.create({
    data: {
      type: 'agent', agentType: 'CUSTOM', priority: 'MEDIUM',
      description: spec.title, objective: spec.instructions, context: {},
      schedule: { type: 'manual', timezone: 'UTC', isActive: false },
      status: 'ACTIVE', visibility: 'shared', organizationId, userId,
      metadata: {
        title: spec.title, description: spec.title, model: spec.model ?? 'gpt-4o',
        integrations: spec.integrations, skills: [], icon: '', allowSubagents: false, subagentIds: [],
      },
    },
    select: { id: true },
  })
  return agent.id
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { seedKey } = body.parse(await request.json())
  const seed = getSeedByKey(seedKey)
  if (!seed) throw new ApiError('Template not found', 404, 'SEED_NOT_FOUND')
  const { organizationId } = auth
  const userId = auth.dbUser.id

  if (seed.kind === 'agent') {
    const agentId = await materializeAgent(
      { title: seed.name, instructions: seed.instructions ?? seed.description, model: seed.model, integrations: seed.integrations ?? [] },
      organizationId, userId,
    )
    await syncAgentConnectors(agentId, organizationId, seed.integrations ?? [])
    return { success: true, kind: 'agent' as const, agentId }
  }

  // flow: materialize embedded agents, rewrite refs, create a DRAFT flow.
  const specs: TemplateAgentSpec[] = seed.agents ?? []
  const refToId: Record<string, string> = {}
  const created: Array<{ id: string; integrations: string[] }> = []
  for (const spec of specs) {
    const id = await materializeAgent(spec, organizationId, userId)
    refToId[spec.ref] = id
    created.push({ id, integrations: spec.integrations })
  }
  const graph = rewriteGraphAgentRefs(seed.flowGraph!, refToId)
  const trigger = seed.trigger ? normalizeFlowTrigger(seed.trigger) : triggerFromGraph(graph)
  const flow = await prisma.flow.create({
    data: {
      name: seed.name, description: seed.description, status: 'DRAFT', visibility: 'shared',
      trigger: jsonValue(trigger), graph: jsonValue(graph),
      metadata: jsonValue({ seededFrom: seed.seedKey }),
      organizationId, userId,
    },
    select: { id: true },
  })
  // Project connector bindings for each materialized agent (best-effort, post-create).
  await Promise.all(created.map((a) => syncAgentConnectors(a.id, organizationId, a.integrations).catch(() => undefined)))
  return { success: true, kind: 'flow' as const, flowId: flow.id }
})
```

**Notes / constraints honored:**
- Cross-tenant: every write is `organizationId`/`userId` from `auth`. Seed is static.
- DRAFT-only: `status:'DRAFT'` — user reviews + activates in `/flows/{id}`.
- Idempotency: v1 provisions fresh each click (like "Use template" today). A dedupe-by-`metadata.seededFrom` guard is a possible follow-up, out of scope.

**VERIFY:** `npx tsc --noEmit`, then a manual smoke via the detail page (Task 8). The pure rewrite is already unit-tested (Task 5); the route is thin I/O over tested helpers, so no route-level unit test is added (consistent with sibling routes).

---

## Task 7 — Templates page UI: department filter + Catalogue section + Connect CTA

**Files:** `src/app/templates/page.tsx` (edit)
**Depends on:** Tasks 3, 4.

**Changes:**
1. Extend `TemplateItem` with `departments?: string[]`, `requiredIntegrations?: string[]`, `recommendedIntegrations?: string[]`, `kind?: 'agent'|'flow'`, `seed?: boolean`, `seedKey?: string`.
2. In `load()`, also fetch `/api/integrations/available`; store `connected = connectedSlugSet(data.tools)` (from `@/lib/templates/relevance`).
3. Split templates three ways (existing `mine`/`community` split preserved):
```ts
const seeds = filteredTemplates.filter((t) => t.seed)
const myTemplates = filteredTemplates.filter((t) => t.mine && !t.seed)
const communityTemplates = filteredTemplates.filter((t) => !t.mine && !t.seed)
```
4. **Department filter** — a row of toggle chips above the tabs:
```ts
const [dept, setDept] = useState<Department | 'all'>('all')
const inDept = (t: TemplateItem) => dept === 'all' || (t.departments ?? []).includes(dept)
```
   Apply `inDept` to `seeds` (and optionally community). Render chips from `DEPARTMENTS` + an "All" chip; active chip highlighted. Never removes the tab structure.
5. **Starter catalogue section** (above Community, below Your library): `sortByReadiness(seeds.filter(inDept), connected)` mapped through a new `renderCatalogueCard(t)`.
6. **`renderCatalogueCard`** = the existing card visual, plus:
   - a small department label (first `t.departments`),
   - readiness: `const missing = missingIntegrations(t.requiredIntegrations ?? [], connected)`,
   - when `missing.length > 0`, an overlaid **"Connect to use"** pill (links to `/integrations`) and the missing chips subtly emphasized; when ready, a **"Ready to run"** badge. The card still links to `/templates/{id}`. Never hidden.
```tsx
{missing.length > 0 ? (
  <Link href="/integrations" onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
    Connect to use
  </Link>
) : (
  <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700 text-[11px]">Ready to run</Badge>
)}
```
7. Keep the existing Community section exactly as-is for non-seed rows.

**VERIFY:** run the app (`npm run dev`), open `/templates`: seeds appear in "Starter catalogue", ready-first; missing-tool seeds show "Connect to use"; department chips filter; search + Community + Your library unchanged. (Pure helpers already unit-tested in Task 4.)

---

## Task 8 — Detail page provision/Connect + BI department tie-in

**Files:** `src/app/templates/[id]/page.tsx` (edit), `src/lib/intelligence/template-from-run.ts` (edit)
**Depends on:** Tasks 1, 6.

**8a — Detail page:**
1. Extend `Template` type with `kind?: 'agent'|'flow'`, `seed?: boolean`, `seedKey?: string`, `requiredIntegrations?: string[]`, `departments?: string[]`. Drop the dead `playbook` field + `deployPlaybook` (which POSTs to the non-existent `/api/playbooks/{playbook}`).
2. On load, also `fetch('/api/integrations/available')` → `connected` set; compute `missing = missingIntegrations(template.requiredIntegrations ?? [], connected)`.
3. Replace `deployPlaybook` with `provision`:
```ts
const provision = async () => {
  if (!template?.seed) return createAgent() // legacy non-seed templates keep POST /api/agents
  setDeploying(true)
  const res = await fetch('/api/templates/provision', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seedKey: template.seedKey }),
  })
  const data = await res.json().catch(() => ({}))
  setDeploying(false)
  if (res.ok && data.kind === 'flow' && data.flowId) router.push(`/flows/${data.flowId}`)
  else if (res.ok && data.kind === 'agent' && data.agentId) router.push('/dashboard')
}
```
4. Primary button logic (never hidden):
   - `missing.length > 0` → **"Connect to use"** button linking to `/integrations` (lists the missing integrations beneath).
   - else, seed → **"Use template"** (flow) / **"Create agent"** (agent) calling `provision`; non-seed → existing `createAgent`.
5. Keep the "Requires" chips; add a "Departments" line from `template.departments`.

**8b — BI department tie-in (`template-from-run.ts`):** tag every auto-generated template with departments derived from its tools, so the same taxonomy powers catalogue + relevance + auto-distilled templates and the department filter works on "From your runs" cards too.
   - RED: extend `src/lib/intelligence/__tests__/template-from-run.test.ts` — assert the built `configuration.departments` equals `departmentsForTools(integrations)` for a sample integration set (the existing test file already exercises `maybeCreateTemplateFromRun` helpers; add a focused unit around the configuration assembly, or refactor the config assembly into a tiny pure `buildAutoTemplateConfig(...)` and test that).
   - GREEN: in the `configuration` object (currently L145–153), add:
```ts
import { departmentsForTools } from '@/lib/templates/departments'
// ...
const configuration: Record<string, unknown> = {
  instructions: objective,
  integrations,
  model,
  autoGenerated: true,
  departments: departmentsForTools(integrations),   // ← BI tie-in
  sourceExecutionId: executionId,
  ...(replayable.exampleInput ? { exampleOutput: replayable.exampleInput } : {}),
  ...(candidateEmbedding.length > 0 ? { embedding: candidateEmbedding } : {}),
}
```

**VERIFY:** `npm test` (template-from-run + all `src/lib/templates` suites), `npx tsc --noEmit`, then drive the app: open a **flow** seed detail → "Use template" → lands on a DRAFT `/flows/{id}` with the wired agents; open a seed missing a required tool → "Connect to use" → `/integrations`.

---

## Verification checklist (whole feature)

- `npm test` green: `departments`, `relevance`, `catalogue` (all 20 graphs schema-valid, refs resolve, no per-org ids), `provision-plan`, extended `template-visibility` + `template-from-run`.
- `npx tsc --noEmit` clean (esp. `agent-templates/route.ts` — no non-handler exports added).
- Manual: `/templates` shows a ready-first Starter catalogue with department chips + Connect CTAs; a flow seed provisions a DRAFT Flow with materialized agents; an agent seed provisions an agent; nothing leaks cross-org; Community/Your library/search unchanged.

---

## Where the real code makes this harder than the design assumed

1. **Inline-prompt agent nodes are NOT executable.** `graph.ts` (L79) declares `prompt`/`model` on the agent node, but `interpret.ts` (L15, L321) and `execute-flow.ts` (L361–364) dispatch purely by `node.data.agentId` — the prompt is never read. **Consequence:** flow templates cannot be self-contained via inline prompts. The design's "keep template flowGraphs self-contained" is realized by **embedding `TemplateAgentSpec`s and materializing real `AgentTask` rows at provision time**, then rewriting `agentId` placeholders (Tasks 5–6). This is the single biggest deviation.

2. **Per-org planes have no stable connection id.** `formatFlowToolConnectionId` keeps MCP rows **raw** (per-org cuid) and Klavis ids are per-org `mCPAgent` rows. So a static seed graph **cannot** hardcode a working `connectionId` for github/hubspot/zendesk/linear/confluence/notion/google_sheets/google_drive/snowflake/asana. **Consequence:** all such access is routed through **agent nodes** (the agent runtime binds those planes by the agent's `integrations` selection at run time). Only `native:slack`, `nango:salesforce`, `nango:gmail` — and the connection-less `http` node type — are used as deterministic steps. The catalogue test enforces "no per-org connection ids in seed graphs."

3. **The "Deploy as Flow" button was already dead.** `templates/[id]/page.tsx` POSTs to `/api/playbooks/{playbook}` which **does not exist** (no `src/app/api/playbooks` directory). Task 8 removes the dead path and points the button at the new `/api/templates/provision`.

4. **Connected-slug vocabulary is not uniform.** `GET /api/integrations/available` emits mixed-case builtin keys (`'Slack'`, `'Granola'`, `'HTTP API'`), nango keys, and lowercased Klavis agentTypes; `integration-chip` maps by substring to *logo* slugs (`googlesheets`, `mondaydotcom`). Matching required-vs-connected needed a dedicated `canonicalIntegrationSlug()` (Task 1) rather than trusting any single existing field.

5. **`serializeTemplate` is the client's only view.** The detail page loads a template by finding it in the **GET list** (no per-id fetch), so seeds must be fully represented in the list wire shape — hence `serializeSeed` mirrors `serializeTemplate` exactly plus additive fields, while **omitting** `flowGraph`/`agents` (kept server-only so provision reads them from the catalogue, not from client input).

6. **Route module export hygiene.** `template-visibility.ts`'s own header notes that Next.js route modules may only export handlers/config; adding helpers to `route.ts` breaks the generated type check. All new pure logic therefore lives under `src/lib/templates/*`, never in the route file.

7. **Boolean gate tokens are a runtime unknown.** The two `filter`-node gates compare an agent's JSON boolean (`escalate`/`breach`) stringified via the datatree to `'true'`. The catalogue schema test cannot validate this resolves correctly; the executing session must confirm against `src/lib/flows/datatree.ts` and fall back to a `condition` node or a string sentinel if booleans don't stringify to `'true'`.
```
