# n8n node parity — config panels and node coverage

Date: 2026-08-24
Reference: `n8n-io/n8n` @ HEAD, sparse clone of `packages/nodes-base` + `@n8n/nodes-langchain`
Prior work: the 2026-08-07 audit covered **import/export fidelity and credentials**
(432 schemas, 392 credential types). This is a different axis — what the
builder offers and how a node's config is composed.

## Ground truth

| | n8n | Sublime |
| --- | --- | --- |
| Node directories | 308 | — |
| `.node.ts` descriptors (incl. versions) | 556 | — |
| **Core Nodes** (n8n's own codex classification) | **74** | — |
| LangChain nodes | 135 | — |
| Credential types | 409 | 8 generic + a 391-entry mapping |
| Builder node types | — | **23** (22 body components) |
| Data operations | — | 12 (`DATA_OPS`) |

**23 vs 556 is not the comparison.** Most n8n nodes are one-per-vendor
integrations (Slack, Gmail, Notion). Sublime routes integrations through a
generic `tool` node over connection planes (`nango:`, `native:`, `mcp:`,
`postgres:`, `flow:`), so a new integration adds a *connection*, not a node.
The meaningful comparison is against n8n's **74 Core Nodes**.

---

## Part 1 — Config panels: the architecture is the problem

### The difference

**n8n declares parameters as DATA.** Each node exports `INodeProperties[]`,
and every property carries `displayOptions`:

```
displayOptions: { show: { resource: ['message'], operation: ['post'] } }
```

One generic renderer walks that array for every node in the product. Whether a
field appears is a property *of the field*, evaluated against current values.

**Sublime declares parameters as CODE.** 22 hand-written `*-body.tsx` modules
in a `NODE_BODIES: Record<FlowNode['type'], NodeBodyModule>` registry. Whether
a field appears is a hand-written `&&` inside JSX.

That single difference explains everything below. When visibility is data, a
node is "only what's relevant to it" *mechanically*. When it is code, staying
relevant is a thing someone has to remember on every edit — and the evidence
says it is not being remembered.

### Evidence: the `data` node

`DATA_OPS` has **12** operations. `data-body.tsx` (208 lines) branches on
exactly **4** of them:

```
branched : join, parseJson, filterArray, select
no branch: compose, csvTable, htmlTable, slackMessage,
           sort, limit, dedupe, splitOut
```

The schema carries op-specific fields — `separator`, `schema`, `clauses`,
`fields`, `count`, `field` — as one flat optional bag, all present regardless
of the selected op. n8n would gate each with `displayOptions`.

Two consequences that are live user-facing bugs, not stylistic:

**1. `limit` is unconfigurable.** `data.count` is referenced **zero times** in
the body, yet [data-ops.ts:215](../../src/lib/flows/data-ops.ts) executes:

```ts
const count = Math.max(1, Math.min(10000, config.count ?? 10))
```

The builtin catalogue offers "Limit items — Keep only the first N items."
Adding it silently pins N to **10**, with no way to change it. The field is
validated and executed; it just has no control.

**2. `forEachItem` is unreachable.** Also **zero** references in the body, but
`interpret.ts` acts on it in three places (772, 809, 931). This is the
n8n-parity per-item fan-out — built, executing, and impossible to turn on.

### Evidence: `filter` has no panel of its own

The registry maps `filter: conditionModule`. A Filter step therefore renders
Condition's UI. They are not the same node: a condition **branches** (true
output, false output), a filter **keeps or drops items**. The panel describes
the wrong semantics — precisely "config options not relative to that node".

### What is already right

`advancedParamKeys(type)` is a per-type manifest, and `StepSettingsFooter` is
correctly universal (per-step notes only). So the *chrome* is scoped properly;
it is the *node bodies* that drift. The fix is not to scope shared panels — it
is to stop expressing per-node visibility as bespoke JSX.

### Recommendation

Move node parameters to a declarative manifest with n8n-style
`displayOptions`, rendered by one generic component, and keep a bespoke body
only where a node genuinely needs custom UI (the canvas-aware ones: agent,
tool, trigger, code). Ordered so value lands before the refactor completes:

1. **Fix the two live bugs first** — surface `count` for `limit` and
   `forEachItem` where it applies. Small, immediate, independent of any
   refactor.
2. **Give `filter` its own body.** Stop borrowing Condition's.
3. **Introduce the manifest for `data` first.** It is the worst offender and
   the best proof: 12 ops × field visibility is exactly the case
   `displayOptions` exists for.
4. **Migrate the remaining simple bodies** as they are touched, not in one
   sweep.

---

## Part 2 — Node coverage

Mapping n8n's 74 Core Nodes against Sublime. **Accounting for `DATA_OPS`
matters**: a naive comparison reports 8 missing data nodes when 5 already
exist as operations.

### Already covered

| n8n | Sublime |
| --- | --- |
| If | `condition` |
| Switch | `switch` |
| Filter | `filter` + `data.filterArray` |
| Code / Function / FunctionItem / AiTransform | `code` |
| SplitInBatches | `loop` |
| Wait | `wait` |
| StopAndError | `stop` |
| ExecuteWorkflow (+Trigger) | `subflow` |
| RespondToWebhook | `respondWebhook` |
| HttpRequest | `http` |
| Webhook / Schedule / Manual / Cron / Interval / Form triggers | `trigger` types |
| Set (Edit Fields) | `data.select`, `variable`, `transform` |
| Sort | `data.sort` |
| Limit | `data.limit` *(unconfigurable — see Part 1)* |
| RemoveDuplicates | `data.dedupe` |
| SplitOut | `data.splitOut` |
| ItemLists *(deprecated upstream)* | `data` ops |
| Html (tables) | `data.htmlTable` |
| ErrorTrigger | `errorShield` |
| NoOp | — *(trivial; not worth a node)* |

Sublime additionally has **no n8n equivalent** for: `agent`, `humanReview`,
`router`, `parallel`, `repeatUntil`, `errorShield`, `input`/`output`.

### Genuine gaps, ranked

**Tier 1 — data shaping, the real hole**

1. **Merge** — join two branches on a key. Sublime can fan out (`parallel`,
   `router`) but cannot fan back in. This is the most-used n8n core node with
   no Sublime answer.
2. **Aggregate / Summarize** — group items and compute counts/sums. No
   equivalent op; `select` maps fields but does not reduce.
3. **CompareDatasets** — diff two lists into added/removed/changed.

**Tier 2 — format and parse**

4. **DateTime** — parse, format, add/subtract. Today this means a `code` step.
5. **Xml** — parse/build. `parseJson` has no XML sibling.
6. **Markdown** — convert to/from HTML.
7. **Crypto** — hash, hmac, sign. Common for webhook signature verification.

**Tier 3 — binary and files (architecturally blocked)**

ConvertToFile, ExtractFromFile, ReadWriteFile, SpreadsheetFile, ReadPDF,
Compression, EditImage, MoveBinaryData. The 2026-08-07 audit already
identified the blocker: **there is no run-engine binary store**, so buffers
cannot pass between steps. That is a runtime change, not a node, and should be
specced on its own before any of these are attempted.

**Out of scope** — n8n-internal (`N8n`, `ExecutionData`, `StickyNote`,
`Simulate*`, `E2eTest*`, `TimeSaved`), infrastructure (`ExecuteCommand`,
`Ssh`, `Ftp`, `Git`) which conflict with Sublime's sandboxing posture, and
`EmailSend`/`EmailReadImap` which the delivery-tool plane already covers.

### The honest summary

Sublime's **control flow is at or ahead of parity** — it has seven node types
n8n has no equivalent for. The coverage gap is narrower than "we are lacking
nodes" suggests, and it is concentrated in one place: **items in, items out**.
Merge and Aggregate are the two that would close most of it.

---

## Suggested order

1. `data.count` + `forEachItem` UI — live bugs, hours not days
2. `filter` gets its own body
3. Declarative parameter manifest, `data` node first
4. **Merge** node
5. **Aggregate / Summarize** op
6. DateTime, Crypto, Xml, Markdown
7. CompareDatasets
8. Binary store — own spec, own decision
