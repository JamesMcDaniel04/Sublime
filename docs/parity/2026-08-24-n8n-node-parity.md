# n8n node parity — config panels, composability, and coverage

> **Superseded by `2026-08-24-n8n-deep-parity-audit.md`** — a full-checkout
> enumeration rather than a hypothesis-driven grep. Kept for its detail; the
> successor corrects the method and the conclusions.


> **Superseded by `2026-08-24-n8n-flow-parity.md`.** This document audits
> NODES. The question was flow-system parity, and the subsystems it does not
> examine — execution data model, expression surface, flow settings, platform
> — contain larger differences. Kept for the node-level detail, which the
> successor summarises rather than repeats.

Date: 2026-08-24 (revised same day — see "What the first pass got wrong")
Reference: `n8n-io/n8n` @ HEAD, sparse clone of `packages/nodes-base` +
`packages/@n8n/nodes-langchain`
Prior work: the 2026-08-07 audit covered **import/export fidelity and
credentials** (432 schemas, 392 credential types). This covers what the
builder offers and how a node's config is composed.

## What the first pass got wrong

The first version of this document counted nodes: 74 n8n "Core Nodes" against
Sublime's 23 types, concluded the gap was "narrow and specific — items in,
items out", and recommended Merge and Aggregate.

That was shallow in a specific way. **It counted the 135 LangChain nodes and
then never looked at them**, waving them off with the same "integrations are
handled by the tool plane" argument used for Slack and Gmail. That argument is
wrong for the AI nodes, because they are not integrations — they are the
composable parts of an AI stack, attached through a connection system Sublime
does not have. It also collapsed 115 trigger nodes into "trigger types"
without checking which transports they represent.

The real differences are architectural, not numeric. Restructured below by
axis, largest first.

## Ground truth

| | n8n | Sublime |
| --- | --- | --- |
| Node directories / descriptors | 308 / 556 | — |
| Core Nodes (n8n's codex) | 74 | — |
| **LangChain sub-nodes** | **135** | — |
| **Typed connection ports** | **10** (`main` + 9 `ai_*`) | **1** (`main`) |
| **Nodes usable as an AI tool** | **274** | — |
| Trigger nodes / distinct transports | 115 / ~12 | 7 trigger types |
| Multi-version nodes (`typeVersion`) | 66 | not modelled |
| Credential types | 409 | 8 generic + 391-entry map |
| Builder node types | — | 23 (23 bodies) |
| Data operations | — | 13 (`DATA_OPS`) |

---

## Axis 1 — Composability of the AI stack (the biggest gap)

n8n exposes AI as **sub-nodes that attach to a parent through typed ports**.
Nine of them: `ai_agent`, `ai_chain`, `ai_document`, `ai_embedding`,
`ai_languageModel`, `ai_memory`, `ai_outputParser`, `ai_textSplitter`,
`ai_tool`. An Agent node has sockets; you plug a model into one, a memory into
another, a vector store into a third.

What plugs in:

| Port | n8n options | Sublime |
| --- | --- | --- |
| Language model | **24** (Anthropic, OpenAI, Bedrock, Vertex, Gemini, Groq, Mistral, Ollama, OpenRouter, DeepSeek, xAI, Azure, Cohere, Nvidia…) | 3 wires — Anthropic (Claude + Qwen), OpenAI |
| Vector store | **24** (pgvector, Pinecone, Qdrant, Weaviate, Milvus, Chroma, Mongo Atlas, Redis, Supabase, Zep…) | fixed: Neo4j graph + pgvector |
| Embeddings | **12** | fixed: Voyage |
| Memory | **9** (buffer window, Postgres, Redis, Mongo, Motorhead, Xata, Zep…) | fixed: `AgentMemory` |
| Output parser | 3 | `outputFields` (structured output) |
| Text splitter / doc loader | 3 / 4 | fixed ingestion in `KnowledgeDocument` |
| Reranker | 1 | `VOYAGE_RERANK_MODEL` (optional) |

**This is a product-philosophy difference, and Sublime's side has real
advantages.** n8n makes you wire five nodes before an agent answers anything;
Sublime's agent works out of the box with graph RAG, memory, and tool planes
already attached. Nobody has to know what a text splitter is.

The cost is that **nothing is swappable**. A workspace that standardised on
Pinecone, or must use Bedrock for procurement reasons, or wants Gemini for
long context, cannot express that. There is no seam — not "a seam we have not
built a UI for", but no connection type to attach one to.

**Recommendation: do not port the sub-node architecture.** It would rebuild
the product around wiring. The proportionate move is a **provider seam** at
the three points where lock-in actually bites, in this order:

1. **Language model** — largest, most requested, and already half-done:
   `model-runner.ts` has a provider abstraction with a fallback order.
   Extending it is not architectural.
2. **Embeddings** — `embeddings.ts` already documents itself as "behind a
   small seam so it can be swapped (OpenAI, a local model)". The seam exists
   and is unused.
3. **Vector store** — `GraphRagStore` is already an interface with two
   implementations. A third is a class, not a redesign.

That buys most of the flexibility for none of the wiring.

## Axis 2 — Any node as an AI tool

**274 n8n nodes carry `usableAsTool`.** Any of them can be attached to an
Agent and called as a tool.

Sublime's agent gets tools from connection planes (`native:`, `nango:`,
`mcp:`, `postgres:`, `flow:`) — a different mechanism reaching a similar
place, and **one plane has no n8n equivalent: `flow:` makes an entire flow
callable as an agent tool.** n8n cannot do that as cleanly; its Agent calls
tools, not workflows.

Gap: a *step type* cannot be a tool. An agent cannot be handed "the HTTP step"
or "the Postgres step" as a capability the way n8n can. Whether that matters
is a product question — Sublime's answer is that a flow wrapping that step is
the tool, which is arguably better because it is named and testable.

**Not a gap to close. Worth stating so it stops being mistaken for one.**

## Axis 3 — Trigger transports

115 trigger nodes, but most are per-vendor webhooks that Sublime's generic
`webhook` and `poll` already subsume. Stripping vendor triggers leaves roughly
twelve distinct transports, and this is where the real holes are:

| Transport | n8n | Sublime |
| --- | --- | --- |
| HTTP webhook | Webhook | `webhook` |
| Schedule / cron / interval | Schedule, Cron, Interval | `schedule` |
| Manual | ManualTrigger | `manual` |
| Polling a read action | per-vendor | `poll` |
| Sub-workflow | ExecuteWorkflowTrigger | `subflow` |
| Error | ErrorTrigger | `errorShield` + `errorFlowId` |
| **Message queue** | Kafka, AMQP, MQTT, RabbitMQ, Redis, AWS SNS | **none** |
| **Email (IMAP)** | EmailReadImap | **none** |
| **Hosted form** | Form + FormTrigger | **none** |
| **Chat** | Chat Trigger (LangChain) | **none** |
| **SSE** | SseTrigger | **none** |
| **Local file** | LocalFileTrigger | none *(no filesystem by design)* |
| RSS | RssFeedReadTrigger | reachable via `poll` |

Ranked by what a workspace would actually miss:

1. **Hosted form trigger.** A form that starts a flow and collects typed
   input. Sublime has `input` nodes and `humanReview` mid-run, but no way for
   someone outside the workspace to *start* one. The pieces largely exist.
2. **Email (IMAP) trigger.** "When an email arrives" is a top-tier automation
   primitive and there is no path to it today.
3. **Queue triggers** (Kafka/AMQP/MQTT/RabbitMQ/Redis). Architecturally
   different from everything Sublime has: a long-lived consumer, not an HTTP
   handler or a poll tick. This is worker work before it is node work, and it
   should get its own spec.
4. **Chat trigger.** Overlaps the assistant surface; probably a product
   decision rather than a node.

## Axis 4 — Node versioning

66 n8n nodes ship multiple `typeVersion`s with different parameter shapes.
Sublime does not model node versions at all. The 2026-08-07 audit already
flagged this for import fidelity (Set/If/Switch/Code differ across versions).

The forward-looking half is untouched: **Sublime cannot evolve a node's
params without migrating every existing flow in place.** Today that is
survivable because node shapes are young. It gets expensive later, and the
declarative manifest (Axis 6) is the natural place to hang a version on.

## Axis 5 — Core data nodes

The original finding, still valid, now correctly scoped. Accounting for
`DATA_OPS` matters: a naive diff reports 8 missing data nodes when
`sort`/`limit`/`dedupe`/`splitOut`/`filterArray`/`select` already exist as
operations, and `aggregate` was added today.

Remaining:

1. **Merge** — join two branches on a key. Sublime can fan out (`parallel`,
   `router`) but cannot fan back in. Needs a node with two inputs, which
   touches the canvas and the interpreter — the largest single item here.
2. **CompareDatasets** — diff two lists into added/removed/changed.
3. **DateTime, Crypto, Xml, Markdown** — format and parse. Crypto and DateTime
   need no dependency (`node:crypto`, `Date`/`Intl`); Xml and Markdown need
   parsers, which is why `DATA_OP_LABELS` was moved out of the executor so
   those can land server-side without touching the 400k browser budget.

## Axis 6 — Config panels

n8n declares parameters as **data** — `INodeProperties[]` with
`displayOptions`, walked by one generic renderer. Sublime declares them as
**code** — hand-written `*-body.tsx` where visibility is an `&&` in JSX.

That difference produced three live bugs, all found and fixed today:

- `data.count` referenced zero times in the body while `data-ops.ts` ran
  `config.count ?? 10` — "Limit items" silently pinned N to 10.
- `data.field` — `splitOut` could not name the field it fans out on.
- `splitItems` — executed in three places, no control anywhere, which meant
  **the Filter node could not filter**; it only gated.

The http node's own Options panel already documents a prior occurrence of the
same class. It keeps recurring because per-node visibility is code.

In progress: `node-params.ts` (declarative specs with n8n's `showWhen`
semantics), `data-params.ts` (the data node declared), and a coverage test
that fails when a schema key has neither a spec nor a written reason —
modelled on `route-permissions.test.ts`, and verified to fire.

## Axis 7 — Binary and files (blocked)

ConvertToFile, ExtractFromFile, ReadWriteFile, SpreadsheetFile, ReadPDF,
Compression, EditImage, MoveBinaryData. The 2026-08-07 audit identified the
blocker: **no run-engine binary store**, so buffers cannot pass between steps.
A runtime change, not a node. Own spec.

---

## Where Sublime leads

Stated so none of the above reads as a rewrite mandate. Seven node types have
no n8n equivalent: `agent` (a managed agent, not a wiring exercise),
`humanReview` (first-class mid-run human input), `router`, `parallel`,
`repeatUntil`, `errorShield`, `input`/`output`. Plus the `flow:` tool plane,
per-user node pins, jam comments with point anchors, a dispatch outbox, and
webhook ingress idempotency — none of which n8n has.

## Revised order

1. Config-panel manifest *(in progress — closes a live bug class)*
2. **Merge** — the one core node with no workaround
3. **Provider seam: language model** — biggest lock-in, abstraction half-built
4. **Form trigger** — the most-missed way to start a flow
5. DateTime, Crypto (no dependencies) → Xml, Markdown (parsers)
6. **Provider seam: embeddings**, then vector store
7. CompareDatasets
8. Email/IMAP trigger
9. Queue triggers — own spec, worker work
10. Node versioning — hang off the manifest
11. Binary store — own spec

Items 3, 4, 8 and 9 are the ones the first pass missed entirely.
