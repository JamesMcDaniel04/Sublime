# Universal Markdown Knowledge Substrate — Design Spec

**Date:** 2026-07-11 · **Status:** DRAFT (awaiting user review)

**Goal:** Every artifact an agent produces, every flow run's output, and every uploaded file becomes an Open-Knowledge-Format (OKF) markdown document in a per-org, git-hosted repository — a shared, versioned, human- *and* agent-readable knowledge base. Agents read discoveries from it and write new ones into it, so each subsequent run starts warmer. A derived pgvector index makes the corpus retrievable into agent prompts without changing the existing retrieval pipeline.

**One-line architecture:** Per-org **GitHub repository** (source of truth, OKF markdown) ⇄ **`GitProvider`** integration (GitHub App, REST commits — no self-hosted git, no object storage, no persistent volume) ⇄ **derived pgvector index** (retrieval) ⇄ **agent read/write tools** + **per-source converters** (agent runs, flow runs, uploads).

---

## 1. The loop (user's framing, mapped to architecture)

```
agent/flow run, or upload ──► CONVERT to OKF markdown
                                      │
                         WRITE (reconcile-on-write: merge / supersede / new)
                                      │
                    commit to per-org git repo  +  refresh derived index
                                      │
next run ──► RETRIEVE (pgvector) folded into the prompt ◄─────────┘
                                      │
        agent RECORDS a discovery ──► scratch/ ──► promote ──► canonical/
```

The user's words: *"convert all artifacts the agents produce, flows produce, and even things we upload into some sort of markdown file so that it makes it easier to retain information and share that information with other agents. There needs to be a universal language / repository to keep important discoveries that the agents can easily access and understand."*

## 2. What exists today (why this is a convergence layer, not a fourth silo)

The platform has **three parallel, disjoint retrieval systems** feeding one prompt assembler ([assemble.ts](../../../src/lib/context/assemble.ts)) — and **no document repository**:

1. **Uploaded-file knowledge** — [POST /api/agents/[id]/knowledge](../../../src/app/api/agents/[id]/knowledge/route.ts) extracts text ([extract.ts](../../../src/lib/knowledge/extract.ts)), chunks (~1200 chars/150 overlap), embeds (Voyage `voyage-3`, 1024-dim), and stores `KnowledgeDocument` (**metadata only — no body/title/source**) + `KnowledgeChunk` (pgvector HNSW). The binary is discarded. Agents can only **read**. There is **no blob storage anywhere in the app.**
2. **Agent memory** — [agent-memory.ts](../../../src/lib/memory/agent-memory.ts): the *only* agent-writable store. 3 fixed kinds, deduped on write (cosine ≥0.86), capped at 500, status `open|dismissed|superseded`, provenance via `sourceExecutionId`/`sourceRef`. Strictly per-agent.
3. **Graph-RAG** — [src/lib/rag/](../../../src/lib/rag/): typed node+edge store (Neo4j prod / in-memory dev), **gated off** unless `ragEnabled()` (Voyage **and** Neo4j) — not live in current prod.

**Three gaps this spec closes:**
- **Flow-run outputs are invisible to every retrieval system** — [execute-flow.ts](../../../src/features/flows/execute-flow.ts) writes opaque JSON blobs never chunked/embedded/indexed. Largest coverage gap.
- **No canonical markdown body exists anywhere** — text lives fragmented across chunks; nothing is addressable or citable.
- **No agent write-to-shared-repo path** — an agent cannot record a discovery another agent can browse by name.

## 3. Locked decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Storage / source of truth | **Files-on-disk + git, remote-first: per-org hosted GitHub repos** | Real, portable, versioned, Obsidian-compatible markdown; users own their repo. |
| Git hosting | **Per-org GitHub repositories** (GitLab is a documented future provider) | The repos *are* the durable store — no object storage, no self-hosted git. |
| Auth | **GitHub App** (scoped, short-lived installation tokens) | Strongest security, per-org scope, revocable; users keep repos in their own org. |
| Compute | **Serverless API routes + `after()`** (REST commits) | API-driven commits need no working tree → **not** coupled to the Render worker. |
| Agent writes | **Tiered: free `scratch/` + curated `canonical/`, reconcile-on-write** | No repo flooding; low-friction capture; curated shared truth. |
| Body contract | **OKF markdown** (typed frontmatter + standard links) + optional typed relations | Inherit a real spec; human+machine readable; graph value "for free" later. |
| Retrieval | **Derived pgvector index**, rebuilt on write; 4th `take()` in the assembler | Reuses the always-on pipeline; degrades to keyword search. |
| Rollout | **Phased** (Phase 1 = agent runs + write/read + retrieval; Phase 2 = flows + uploads + scale) | Ships cross-agent value fast on current topology. |
| Spec scope | **Full two-phase vision** documented; implementation plan targets Phase 1 first | User request. |

## 4. Repository model (OKF layout)

One private GitHub repo per org (`<org-slug>-knowledge`), provisioned on first write:

```
<org-slug>-knowledge/
  manifest.md                 ← root progressive-disclosure index (llms.txt-style); cheap, always loadable
  canonical/                  ← shared, curated truth (visibility: shared-to-org)
    accounts/  processes/  integrations/  runbooks/ ...
      <slug>.md
      index.md                ← per-folder auto-generated index (title + one-line summary + link)
  scratch/
    <agentId>/                ← per-agent free-write zone (visibility: private-to-owner by default)
      <slug>.md
  log.md                      ← append-only change ledger (who/what/when/supersedes)
  .sublime/
    schema-version            ← OKF conformance + our extensions version
```

**OKF document contract** (YAML frontmatter + markdown body):

```markdown
---
type: process | account-note | runbook | discovery | upload | flow-report | run-report   # REQUIRED (OKF)
title: Weekly GitHub issue triage
description: How the team triages inbound issues and routes to owners
status: current            # current | superseded | deprecated   (our staleness extension)
timestamp: 2026-07-11T18:04:00Z
review_by: 2026-10-11       # optional freshness deadline (our extension)
source:                     # provenance (recoverable origin)
  kind: agent_run | flow_run | upload | agent_authored
  runId: exec_...           # or flowRunId / uploadId
  connection: github        # when derived from a scanned/used tool
tags: [triage, github, ops]
supersedes: canonical/processes/old-triage.md   # optional
---

## Summary
Prose the agent/human reads…

## Observations            # optional Basic-Memory-style typed lines the future graph indexer reads
- discovered [[canonical/accounts/acme.md]]  (relation: about_account)
- requires [[canonical/integrations/slack.md]]

[Related runbook](canonical/runbooks/triage.md)   # standard portable markdown link
```

Standard `[text](path.md)` links are the **portable baseline**; typed `- relation [[path]]` observations are **optional** and only consumed by the Phase-2 graph indexer — the repo stays fully usable in plain Obsidian without them.

## 5. Components (isolated units + interfaces)

### 5.1 `GitProvider` — provider integration (new: `src/lib/knowledge/git/`)

A thin, swappable abstraction over hosted git. GitHub App implementation first; GitLab later.

```ts
interface RepoRef { provider: 'github'; owner: string; repo: string; branch: string }
interface GitFile { path: string; content: string; sha: string }

interface GitProvider {
  provisionRepo(org: { id: string; slug: string }): Promise<RepoRef>   // idempotent; creates private repo + seed manifest.md
  readFile(repo: RepoRef, path: string): Promise<GitFile | null>
  writeFile(repo: RepoRef, path: string, content: string, opts: { sha?: string; message: string }): Promise<{ sha: string }>
  deleteFile(repo: RepoRef, path: string, sha: string, message: string): Promise<void>
  listDir(repo: RepoRef, path?: string): Promise<{ path: string; type: 'file' | 'dir'; sha: string }[]>
}
```

- **GitHub App auth:** the org installs the "Sublime" GitHub App; we persist only the `installationId` (see `KnowledgeRepo`). Installation access tokens are fetched **on demand** (JWT signed with the app private key → installation token, ~1h TTL) and **never persisted**. The app private key lives in env (Vercel), never in the repo.
- Commits use the **Contents API** (`PUT /repos/{owner}/{repo}/contents/{path}` with base64 + prior `sha` for optimistic concurrency). A 409 (sha mismatch) triggers a read-merge-retry.
- **Rate limits / latency:** per-file API cost is fine for incremental discovery writes; backfills/batch writes use the Git Data API (tree + single commit) and bounded concurrency. All documented, not silently capped.

### 5.2 Data model — the derived index (Prisma; git remains source of truth)

The DB is a **fast, disposable projection** of the repo; on conflict, git wins and the index is rebuilt from it.

- **`KnowledgeRepo`** (new, one per org): `organizationId @unique`, `provider`, `owner`, `repoName`, `branch`, `installationId`, `provisionedAt`, `lastSyncedAt`.
- **`KnowledgeDocument`** (generalize existing): add `repoPath`, `gitSha`, `title`, `body @db.Text` (cached for rechunk/read without an API round-trip), `sourceType` (`upload|agent_run|flow_run|agent_authored`), `tier` (`scratch|canonical`), `status` (`current|superseded|deprecated`), `visibility` (`shared|private`) + `ownerUserId?`, `agentId?`, `frontmatter Json`, `links Json`, `contentHash`, `docEmbedding` (pgvector, doc-level), `sourceExecutionId?`, `flowRunId?`, `supersededById?`, `reviewBy?`, `updatedAt`. Existing upload rows are a subset (`sourceType='upload'`).
- **`KnowledgeChunk`** (reuse unchanged): passage-level embeddings; re-chunked on each write via `chunkText`.
- **`KnowledgePendingWrite`** (new): durable queue row (`organizationId`, `repoPath`, `markdown`, `op`, `attempts`, `lastError`) so a transient GitHub failure never loses a discovery; processed via `after()` + a retry sweep. **Commit point = a successful git write; the index is updated only after that**, keeping git authoritative.

Migration reuses the dual-column pgvector idiom (`ADD COLUMN embeddingVec vector(1024)` + HNSW cosine index + schema re-declare) from `20260710193654_pgvector_embeddings`.

### 5.3 Write path — `writeKnowledgeDoc` (new: `src/lib/knowledge/write.ts`)

One path for **all** sources (generalizes [ingest.ts](../../../src/lib/knowledge/ingest.ts)):

```ts
writeKnowledgeDoc(params: {
  organizationId: string
  tier: 'scratch' | 'canonical'
  ownerUserId?: string; agentId?: string
  sourceType: 'upload' | 'agent_run' | 'flow_run' | 'agent_authored'
  frontmatter: OkfFrontmatter          // type/title/description/status/source/tags…
  body: string                          // markdown
  provenance: { runId?: string; flowRunId?: string; uploadId?: string }
}): Promise<{ docId: string; repoPath: string; action: 'created' | 'merged' | 'superseded' | 'skipped' }>
```

**Reconcile-on-write** (reuses agent-memory's dedupe semantics, generalized to documents):
1. Render OKF markdown (frontmatter + body); compute `contentHash`; embed title+description (doc-level) via `embedTexts`.
2. Query the pgvector index for nearest same-`organizationId` + same-`tier` docs. If cosine ≥ **0.86**:
   - **identical `contentHash`** → `skipped` (idempotent).
   - **near-duplicate** → fetch the existing file, **merge** (append observations / update sections, recency-wins) or **supersede** (mark old `status='superseded'`, set `supersededById`, new doc links `supersedes:`), append a `log.md` entry.
   - else → **create new** at `canonical/<folder>/<slug>.md` or `scratch/<agentId>/<slug>.md`.
3. Commit via `GitProvider.writeFile` (optimistic `sha`; 409 → read-merge-retry).
4. On commit success: upsert `KnowledgeDocument`, re-chunk + re-embed (`KnowledgeChunk`), update `manifest.md`/folder `index.md` (Phase 2 automates regeneration; Phase 1 updates the touched folder's index inline).

Slug/path generation, the merge-vs-supersede-vs-new decision, and frontmatter render/parse are **pure functions** (unit-tested).

### 5.4 Tiers & promotion

- **Automatic converters (run/flow reports) write to `canonical/`**, reconciled-on-write — because reconciliation dedupes/merges/supersedes, repeated similar runs *merge* into one evolving doc rather than flooding the tree. Org-visible by construction (`shared`).
- **Agent ad-hoc discoveries write to `scratch/<agentId>/`** via `record_discovery` — low friction, private-to-owner, reconciled only against that agent's own scratch.
- **Promotion** (`promoteDiscovery`) reconciles a scratch doc into `canonical/` (against the shared canonical set), flipping visibility to `shared`. Triggered by an explicit agent tool (`promote_discovery`) and/or a Phase-2 consolidation pass.
- Rule of thumb: **system-generated artifacts → `canonical/` (reconciled); an agent's own tentative notes → `scratch/` (promote to share).**

### 5.5 Retrieval (extend, don't replace)

- A new `retrieveKnowledgeDocs` mirrors [retrieve.ts](../../../src/lib/knowledge/retrieve.ts)'s pgvector HNSW idiom, scoped by the **visibility contract** (`shared` org-wide ∪ `private` to the caller's `ownerUserId`/`agentId`), with keyword fallback and doc-level vs passage-level routing (doc-embedding finds the right *document*; chunk-embedding finds the right *passage*).
- Folds into the prompt as a **4th `take()`** in [execute-agent.ts](../../../src/features/agents/execute-agent.ts)'s sequential assembler fold — zero new budgeting machinery (`capByBudget`/`dedupeAcrossSystems` already handle it).
- **Read tools** exposed to agents: `search_knowledge(query)`, `read_doc(path)`, `list_index(folder?)` (progressive disclosure: manifest → folder index → doc).

### 5.6 Converters (per source)

- **Agent-run report (Phase 1):** hook [reflectAndRemember](../../../src/features/agents/reflection.ts) to also render a run-report OKF doc (headline, what was done, tools used, structured output re-rendered, provenance frontmatter from the `WorkflowEvent` `context.retrieved`/`knowledge.retrieved`/`memory.retrieved` trail) and call `writeKnowledgeDoc` best-effort.
- **Flow-run report (Phase 2):** single interceptor at the `FlowRun.output` write in [execute-flow.ts](../../../src/features/flows/execute-flow.ts); per-node-type markdown serializers over the heterogeneous node outputs (prose / MCP `structuredContent` / http envelopes / primitives); `graphSnapshot` becomes provenance frontmatter. Closes the largest coverage gap.
- **Upload → markdown upgrade (Phase 2):** replace flat extraction with structure-preserving markdown (`mammoth.convertToMarkdown` for DOCX, structured HTML→md, layout-aware PDF), and reconcile UI (the uploader still hides PDF/DOCX as "coming soon" though the backend supports them).

### 5.7 Consolidation, staleness & graph promotion (Phase 2)

- **Scheduled consolidation/eviction sweep:** dedupe near-duplicate canonical docs, archive `status` where `review_by` passed or the underlying source changed, regenerate every folder `index.md` + root `manifest.md`. Prevents unbounded growth / context rot.
- **Graph-node promotion:** when `ragEnabled()`, index each canonical doc as a first-class graph node (new `document` NodeType or reuse `insight`) with `about_account`/`belongs_to`/`derived_from` edges built from the doc's typed relations — **best-effort, gated exactly like `indexExecution`/`indexAgentMemory`**, so the substrate never depends on Neo4j. Cross-source correlation lights up the moment Graph RAG ships, with no rework.

## 6. Data flow (Phase 1, end to end)

```
agent run completes
  └─ reflectAndRemember (existing)                     [best-effort]
       ├─ distill learnings → AgentMemory (existing)
       └─ render run-report OKF markdown
             └─ writeKnowledgeDoc(tier: canonical)     ← auto artifact, reconciled
                   ├─ embed + pgvector near-dup check (≥0.86) → merge/supersede/new
                   ├─ GitProvider.writeFile → commit         [commit point]
                   ├─ upsert KnowledgeDocument + re-chunk/embed KnowledgeChunk
                   └─ update touched folder index.md + log.md
next agent run
  └─ execute-agent assembler
       └─ take(retrieveKnowledgeDocs)  ← 4th source, visibility-scoped, budget/dedup shared
  └─ agent mid-run
       ├─ search_knowledge / read_doc / list_index      (read tools)
       └─ record_discovery → scratch/<agentId>/          (write tool → writeKnowledgeDoc)
```

## 7. Error handling & degradation

- **Never fail a run** because a knowledge write failed: converters + `record_discovery` are best-effort; a failed commit persists a `KnowledgePendingWrite` and retries via `after()` + sweep.
- **Git is authoritative:** the DB index updates only after a confirmed commit; a rebuild-from-repo path reconciles drift.
- **Embeddings unconfigured:** doc-level dedupe degrades to `contentHash` equality; retrieval degrades to keyword (existing fallback).
- **GitHub App uninstalled / unreachable:** writes queue; reads serve the cached `body`/index; onboarding surfaces "connect knowledge repo" if no `KnowledgeRepo`.
- **Rate limits:** backoff + batch (Git Data API tree commits) for bulk; documented, never silent truncation.

## 8. Security & privacy

- GitHub App **installation tokens fetched on demand, never persisted**; app private key in env only; **never written into the repo**. Reuse [crypto/secrets](../../../src/lib/crypto/secrets.ts) if any provider token must be stored (BYO-token providers, future).
- Repos are **private** by default; users access via their own GitHub org (the App is installed there).
- **Secret scrubbing** on the write path: converters must strip tool credentials / tokens from rendered markdown (agent transcripts can contain secrets) — a required, tested scrubber.
- **One visibility contract** across the substrate: `shared` (org-wide) vs `private` (owner/agent), mapped to `canonical/` vs `scratch/<agentId>/`. Retrieval enforces it identically in the SQL `WHERE`.
- Everything org-scoped by `organizationId`; cross-org reads impossible (repos and index rows are per-org).

## 9. Testing strategy

**Pure/unit (node:test, the repo's established style):**
- OKF frontmatter render ⇄ parse round-trip; unknown/missing fields tolerated.
- Reconciliation decision: identical-hash→skip, ≥0.86→merge/supersede, else→new (table-driven).
- Slug/path generation, tier routing, visibility→`WHERE` predicate.
- Manifest / folder-index generation from a doc set.
- Secret scrubber (known token shapes removed; prose preserved).

**Integration (fake in-memory `GitProvider`, mirroring the in-memory graph store):**
- write→read round-trip; 409 sha-mismatch → read-merge-retry; provisioning idempotency.
- `KnowledgePendingWrite` retry path; commit-then-index ordering (index never ahead of git).
- Retrieval visibility scoping across two orgs / owner vs shared (no cross-org, no cross-owner leakage).

## 10. Phasing

**Phase 1 (implementable now, current topology):** `GitProvider` (GitHub App) + `KnowledgeRepo`/provisioning · `KnowledgeDocument` generalization + migration · `writeKnowledgeDoc` + reconcile-on-write + `KnowledgePendingWrite` · agent-run report converter (reflection hook) · `record_discovery`/`promote_discovery` + `search_knowledge`/`read_doc`/`list_index` tools · `retrieveKnowledgeDocs` as 4th assembler take · a browse surface (list/read docs in-app).

**Phase 2:** flow-run converter (execute-flow hook) · upload→markdown upgrade + uploader UI reconcile · consolidation/eviction sweep + `index.md`/`manifest.md` regeneration · graph-node promotion (gated `ragEnabled`) · optional original-binary retention (Supabase Storage) · optional GitLab provider · optional per-org remote for BYO-token.

## 11. Out of scope

Cross-org knowledge sharing; fine-tuning on the corpus; a real-time collaborative editor over the repo; autonomous canonical publishing without reconciliation; scanning message-content archives at depth. Self-hosted git / persistent working trees (the remote-first API model removes the need).

## 12. Risks & open questions

- **GitHub App onboarding friction** — an install step is required before the first write; mitigate with a clear "connect your knowledge repo" onboarding card and graceful queueing until connected.
- **API-commit latency at scale** — acceptable for incremental writes; backfills need batched tree commits (Phase 2).
- **Merge quality of reconcile-on-write** — LLM-assisted merge vs mechanical section-append is a Phase-1 implementation choice to validate; start mechanical (append observations + supersede), add LLM merge only if needed (YAGNI).
- **Manifest/index freshness in Phase 1** — inline per-folder updates on write; full regeneration is the Phase-2 sweep's job.
