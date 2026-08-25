# n8n ↔ Sublime: full flow-system parity

Date: 2026-08-24 (third pass)
Reference: `n8n-io/n8n` @ HEAD — `nodes-base`, `@n8n/nodes-langchain`,
`workflow`, `core`, `cli`
Supersedes: `2026-08-24-n8n-node-parity.md` (nodes only)
Related: `2026-08-07` audit — import/export fidelity and credentials

## Why there is a third pass

Pass 1 counted nodes (74 core vs 23 types) and concluded the gap was "items in,
items out". Pass 2 added the AI sub-node architecture and trigger transports
after that miss was pointed out. Both were still **node** audits, and the
question was **flow-system** parity.

The subsystems neither pass examined — the execution data model, the
expression surface, flow-level settings, and the platform layer — contain
differences larger than anything in the node list. The data model in
particular is upstream of several "gaps" previously filed as independent.

Ordered by depth, not by ease.

---

## 1. Execution data model — the root difference

**n8n is item-oriented end to end.** Every node receives
`INodeExecutionData[]` and returns `INodeExecutionData[][]` (one array per
output). Each item carries `json`, `binary`, `error`, and **`pairedItem`** —
lineage back to the input item that produced it.

**Sublime is value-oriented.** `FlowContext.step` is
`Record<string, { output: unknown }>`: one value per step. Items are derived
on demand by `itemListFor()`, and per-item execution is an opt-in flag
(`forEachItem`).

This single choice is upstream of at least five things previously filed
separately:

| Consequence | Detail |
| --- | --- |
| No item lineage | Cannot answer "which input produced this output". n8n's `$itemMatching` and paired-item metadata have no analogue; the 2026-08-07 audit already shipped an index-pairing *shim* for imported code steps. |
| No per-item errors | n8n carries failed items alongside good ones in the same stream. Sublime fails the step. |
| No per-item binary | Binary is per-item in n8n; Sublime has no binary store at all (§9). |
| `forEachItem` had to exist | It is a flag reintroducing item semantics onto a value model — and it shipped with no UI at all until today. |
| Branch outputs differ | n8n routes *items* down outputs; Sublime routes *control*. |

**Recommendation: do not migrate the runtime.** A value model is a reasonable
fit for agent-centric flows, where a step output is a document or an answer
rather than a row set, and it is far easier to reason about. But it should be
a *stated* architectural position rather than an accident, because every
item-shaped n8n feature will keep arriving as an awkward special case.

The proportionate move is **paired-item lineage for list-producing steps**:
when a step fans out, record which input index produced each output. That
unlocks the `$itemMatching` family without changing the contract.

## 2. Expression surface

n8n exposes **18** expression globals:

```
$json $binary $item $items $input $node $prevNode $parameter $runIndex
$workflow $execution $vars $secrets $env $now $today $fromAI $nodeVersion
```

Sublime exposes **7** token families: `{{trigger}}`, `{{step.<id>}}`,
`{{var.<name>}}`, `{{item}}`, `{{loop}}`, `{{upstream}}`, `{{js:…}}`.

`{{js:}}` (QuickJS) is a genuine strength — it absorbs arbitrary computation
that n8n needs extension methods for. But several absences bite daily:

| Missing | Why it matters |
| --- | --- |
| **`$now` / `$today`** | Dates require a `{{js:}}` escape or a code step. This is the single most-used n8n expression. |
| **`$secrets`** | No expression-level secret reference; credentials only bind at connection level. |
| **`$env` / `$vars`** | No workspace-level constants. Every flow hardcodes its channel ids and thresholds. |
| **`$execution` / `$workflow`** | A flow cannot reference its own id, name, or run id — needed for logging and idempotency keys. |
| `$runIndex` | No loop-iteration counter outside `{{loop.index}}`. |
| `$fromAI` | n8n's mechanism for an agent to fill a node parameter. Sublime's agent calls tools instead — arguably better, not a gap. |

**Ranked: `$now`/`$today` first** (trivial, high frequency), then `$vars`
(workspace constants), then `$execution`.

## 3. AI composability

n8n has **10 typed connection ports** (`main` + nine `ai_*`); Sublime has
**one**. 135 LangChain sub-nodes attach through them.

| Port | n8n | Sublime |
| --- | --- | --- |
| Language model | 24 | 3 wires (Anthropic/Claude, Qwen, OpenAI) |
| Vector store | 24 | fixed: Neo4j + pgvector |
| Embeddings | 12 | fixed: Voyage |
| Memory | 9 | fixed: `AgentMemory` |
| Output parser | 3 | `outputFields` |
| Text splitter / loader | 3 / 4 | fixed ingestion |
| Reranker | 1 | `VOYAGE_RERANK_MODEL` |

Sublime's managed agent is the better default — n8n makes you wire five nodes
before anything answers. The cost is that **nothing is swappable**, and there
is no seam to attach an alternative to.

**Do not port the sub-node architecture.** Open three provider seams instead,
two of which are already half-built: `model-runner.ts` has a provider
abstraction with fallback ordering, `embeddings.ts` documents a swap seam it
never uses, and `GraphRagStore` is already an interface with two
implementations.

## 4. Trigger transports

115 trigger nodes, but most are per-vendor webhooks that Sublime's generic
`webhook` and `poll` subsume. ~12 distinct transports; Sublime has 7 types
(`manual`, `schedule`, `webhook`, `signal`, `slack`, `activity`, `poll`).

Real holes, ranked by what a workspace misses:

1. **Hosted form trigger.** No way for anyone *outside* the workspace to start
   a flow. Sublime has `input` nodes and `humanReview` mid-run; the pieces
   largely exist.
2. **Email (IMAP).** "When an email arrives" is a top-tier primitive with no
   path today.
3. **Message queues** — Kafka, AMQP, MQTT, RabbitMQ, Redis, SNS.
   Architecturally different: a long-lived consumer, not an HTTP handler or a
   poll tick. Worker work before node work; own spec.
4. **Chat trigger** — overlaps the assistant surface; a product decision.
5. **SSE** — niche.

## 5. Flow-level settings

n8n's `IWorkflowSettings` carries **18** fields: `timezone`, `errorWorkflow`,
`callerPolicy`, `callerIds`, `saveDataErrorExecution`,
`saveDataSuccessExecution`, `saveManualExecutions`, `saveExecutionProgress`,
`executionTimeout`, `executionOrder`, `engineType`, `binaryMode`,
`timeSavedPerExecution`, `timeSavedMode`, `availableInMCP`,
`credentialResolverId`, `redactionPolicy`, `customTelemetryTags`.

Sublime has effectively **two**: `errorFlowId` (in `metadata`) and an
org-level `retentionPolicy`.

Worth taking, in order:

1. **`timezone`** — a schedule trigger today runs on whatever the server
   thinks. For a workspace spanning regions this is a correctness bug, not a
   preference.
2. **`executionTimeout`** — per-flow ceiling. Steps have timeouts; the flow
   does not.
3. **`callerPolicy`** — who may invoke this flow as a sub-flow. Sublime has a
   `flow:` tool plane that makes any flow agent-callable, with no per-flow
   opt-out. That is a governance gap, not a convenience.
4. `saveDataSuccessExecution` — retention is org-wide only; a noisy flow
   cannot opt out of storing every payload.

**`callerPolicy` is the one with a security edge** and should not sit behind
the others.

## 6. Runtime and operations

Closer than expected — Sublime holds its own and leads in places.

| Capability | n8n | Sublime |
| --- | --- | --- |
| Partial execution | execute-from-node | `test-node` route |
| Pin data | pinData | `flow_node_pins` (per-user — n8n's is per-workflow) |
| Retry a run | retry from failure | `resubmit` route |
| Execution history | list + search | run detail routes, workspace history |
| Versioning | workflow history | `FlowVersion` |
| Queue mode | Bull + workers | BullMQ + Fly worker |
| Concurrency | per-instance | per-queue + loop-level |
| Dead letter | — | dead-letter queues **(ahead)** |
| Exactly-once dispatch | — | dispatch outbox **(ahead)** |
| Webhook idempotency | — | ingress idempotency **(ahead)** |
| Wait / resume | wait-tracker | wait + webhook resume |
| **Static data** | `$getWorkflowStaticData` | **none** |
| Deduplication | dedup helper | poll-cursor only |

**Static data is the real gap here.** n8n gives a workflow a persistent
key-value store across runs — how polling triggers remember cursors and how
flows dedupe across executions. Sublime's poll cursor is a special case of it.

## 7. Node coverage

Correctly scoped: `sort`/`limit`/`dedupe`/`splitOut`/`filterArray`/`select`
exist as `DATA_OPS`, and `aggregate` landed today.

1. **Merge** — join two branches on a key. Sublime can fan out (`parallel`,
   `router`) but cannot fan back in. Needs two inputs: canvas + interpreter.
2. **CompareDatasets** — diff two lists.
3. **DateTime, Crypto** — no dependency needed (`node:crypto`, `Date`/`Intl`).
4. **Xml, Markdown** — need parsers; `DATA_OP_LABELS` was moved out of the
   executor so these can land server-side without touching the 400k browser
   budget.

## 8. Config-panel architecture

n8n declares params as **data** (`INodeProperties` + `displayOptions`); Sublime
as **code** (hand-written JSX). That produced three live bugs, all fixed
today: `data.count` (Limit pinned to 10), `data.field` (splitOut), and
`splitItems` (**the Filter node could not filter**).

In progress: `node-params.ts`, `data-params.ts`, and a coverage test —
modelled on `route-permissions.test.ts` — that fails when a schema key has
neither a spec nor a written reason. Verified to fire.

## 9. Binary and files (blocked)

No run-engine binary store, so buffers cannot pass between steps. Blocks
ConvertToFile, ExtractFromFile, ReadWriteFile, SpreadsheetFile, ReadPDF,
Compression, EditImage. Runtime change; own spec. Note §1 — binary is
*per item* in n8n, so this and the data model are the same decision.

## 10. Node versioning

66 n8n nodes ship multiple `typeVersion`s. Sublime does not model versions, so
**node params cannot evolve without migrating every existing flow in place**.
Survivable while node shapes are young; the declarative manifest (§8) is the
natural place to hang a version on.

## 11. Platform and governance

| | n8n | Sublime |
| --- | --- | --- |
| RBAC / projects | projects + roles | capabilities + tenant guard |
| MFA | yes | yes |
| Audit log | security-audit | append-only `AuditEvent` |
| Credential vault | credentials + overwrites | vault, placeholder-only reveal |
| **Source control** | git sync of workflows | **none** |
| **Environments** | dev → prod promotion | **none** |
| **External secrets** | Vault / AWS / Infisical | **none** |
| **Public API** | REST API | **none** |
| Evaluation | `evaluation.ee` | `src/lib/eval` **(comparable)** |
| Billing / plans | — | Stripe **(ahead — n8n is self-hosted)** |
| Goals / outcomes | — | `Goal` spine **(no analogue)** |

**External secrets** is the one to weigh: a flow referencing
`$secrets.vault.apiKey` instead of a vault-stored credential is how larger
orgs expect to work, and it pairs with §2.

---

## Where Sublime leads

Seven node types with no n8n equivalent (`agent`, `humanReview`, `router`,
`parallel`, `repeatUntil`, `errorShield`, `input`/`output`); the `flow:` tool
plane (an entire flow as an agent tool); dispatch outbox; webhook ingress
idempotency; dead-letter queues; per-user node pins; jam comments with point
anchors; goal-linked outcomes; billing.

## Consolidated order

**Cheap and high-frequency**
1. `$now` / `$today` expressions
2. Flow `timezone`
3. `callerPolicy` — governance edge
4. Config-panel manifest *(in progress)*

**Core capability**
5. **Merge**
6. **Static data** — unblocks dedupe and cursor patterns
7. **Form trigger**
8. Model provider seam
9. DateTime, Crypto → Xml, Markdown

**Larger, each its own spec**
10. `$vars` workspace constants → external secrets
11. Paired-item lineage
12. Email/IMAP trigger
13. Embeddings + vector-store seams
14. Queue triggers
15. Node versioning
16. Binary store *(same decision as §1)*
17. Source control / environments

**Explicitly not recommended:** porting the AI sub-node architecture, or
migrating the runtime to an item model. Both would rebuild the product around
n8n's shape rather than Sublime's.
