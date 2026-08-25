# n8n ↔ Sublime — deep parity audit

Date: 2026-08-24 (fourth pass, exhaustive)
Reference: `n8n-io/n8n` @ HEAD — **full checkout**, 315 MB, all packages
Supersedes: `2026-08-24-n8n-node-parity.md`, `2026-08-24-n8n-flow-parity.md`
Related: `2026-08-07` — import/export fidelity and credentials

## Method, and why the first three passes were wrong

Passes 1–3 each grepped for things already hypothesised, then reported what
turned up. That is confirmation, not enumeration, which is why each pass
"found" a few gaps and missed larger ones sitting next to them.

This pass took a full checkout and enumerated the repo before asking any
question: every package, every CLI feature module, every database entity on
both sides. The findings below are derived from that enumeration.

**The headline is not a feature gap.** It is that n8n has shipped a
first-class agent product — 420 files, 22 database entities — that occupies
Sublime's category. Three prior passes classified n8n as "the workflow tool"
and never looked.

## Scale

| | n8n | Sublime |
| --- | --- | --- |
| Packages / `@n8n` scoped | 9 / 60 | — |
| CLI feature modules | **37** | — |
| Node descriptors / directories | 556 / 308 | 23 node types |
| LangChain sub-nodes | 135 | — |
| Typed connection ports | 10 | 1 |
| Credential types | 409 | 8 generic + 391-entry map |
| Platform DB entities | ~70 | — |
| Flow-domain models | — | 11 (`Flow*`) |

---

## A. The strategic finding: n8n has an agent product

`packages/cli/src/modules/agents` — **420 files**, with entities:

```
agent · agent-task · agent-execution · agent-thread · agent-message
agent-knowledge · agent-memory-entry (+cursor +lock +source)
agent-observation (+cursor +lock) · agent-checkpoint
agent-credential-dependency · agent-publish · agent-mcp-access
agent-custom-tools · agent-task-snapshot · agent-task-run-lock
agent-file · agent-resource · agent-chat-subscription
agent-chat-attachment · agent-history
```

Plus `agent-evals` (21 files), `instance-ai` (234), `chat-hub` (49), and an
`@n8n/agents` SDK described as "AI agent SDK for n8n's code-first execution
engine".

Sublime's model is `AgentTask`, `AgentExecution`, `AgentMemory`,
`AgentWorker`, `AgentRequest`, `KnowledgeDocument`, plus graph RAG. The
overlap is near-total. What n8n has that Sublime does not:

| n8n concept | What it buys | Sublime |
| --- | --- | --- |
| **`agent-checkpoint`** | Resume a long agent run from a checkpoint rather than restarting | none — a failed run restarts |
| **`agent-publish` + history** | Draft/published lifecycle for an agent, like a workflow | none — agents are live on save |
| **`agent-memory-entry-source`** | Provenance on every memory: which run wrote it | `AgentMemory` has no source lineage |
| **`agent-observation` + cursors** | Durable, resumable observation stream | `FlowLearningObservation` is flow-scoped |
| **`agent-credential-dependency`** | "Which agents break if this credential is revoked" | none |
| **`agent-mcp-access`** | Expose an agent *as* an MCP server to outside callers | Sublime consumes MCP; does not serve |
| **`agent-custom-tools`** | User-defined tools on an agent | tools come from connection planes only |
| `agent-task-run-lock` | Explicit run-level locking | status-guarded claims (equivalent) |

**Reading this as "build all of it" would be wrong.** Three items are
genuinely load-bearing and the rest is n8n catching up to things Sublime
already does differently:

1. **`agent-publish`** — agents are live on save. There is no draft. Flows
   have `publishedGraph` + `FlowVersion`; agents have nothing equivalent, so
   editing a production agent changes it mid-flight.
2. **Credential dependency** — Sublime cannot answer "what breaks if I revoke
   this connection". It has a credential vault with lifecycle audit, so the
   data exists; nothing indexes it.
3. **Agent-as-MCP-server** — Sublime is an MCP *client*. Serving would make
   every agent callable from Claude Desktop, Cursor, or another n8n.

## B. Platform entities Sublime has no model for

Verified against `prisma/schema.prisma` — all returned zero:

| n8n entity | Capability | Verdict |
| --- | --- | --- |
| `variables` | Workspace constants (`$vars`) | **Real gap.** Every flow hardcodes channel ids and thresholds. |
| `processed-data` | Cross-run dedup store | **Real gap.** `poll-trigger` has a private cursor; nothing general. |
| `tag-entity` + mappings | Tags on workflows | Minor — folders landed today. |
| `folder` | Folders | Closed today (`Flow.folder`). |
| `execution-annotation` + `annotation-tag` | Annotate a run, tag it, feed evaluation | **Real gap** — see §D. |
| `workflow-dependency` / `credential-dependency` | Impact analysis | **Real gap**, same root as A2. |
| `project` + `project-relation` + `role`/`scope` | Projects as a container with roles | Sublime has org + capabilities. Different shape, not obviously worse. |
| `api-key` / `deployment-key` | Public API | **Real gap** — zero API-key surface exists. |
| `secrets-provider-connection` | External secrets | **Real gap** — §C. |
| `workflow-review-request` (+4 tables) | PR-style review before publish | **Real gap** — §E. |
| `workflow-publish-history` / `published-version` / `publication-outbox` | Publish pipeline | Sublime has `publishedGraph` + `FlowVersion` + `FlowDispatchOutbox`. **Roughly at parity.** |
| `poller-state` | Poll cursors | `poll-trigger` state (parity). |
| `binary-data-file` | Binary store | Known blocker. |
| `workflow-statistics` | Per-workflow metrics | `insights` module — §D. |

## C. External secrets

`external-secrets.ee` (53 files) with six providers: **AWS Secrets Manager,
Azure Key Vault, GCP Secrets Manager, Infisical, 1Password, HashiCorp Vault**.
Referenced from expressions as `$secrets.<provider>.<key>`.

Sublime has a credential vault with placeholder-only reveal, key rotation and
lifecycle audit — good, and closer to n8n's *credentials* than to its
*secrets*. The gap is that a workspace cannot point at a secret store it
already runs. For any org with a Vault, this is a procurement blocker, not a
convenience.

Pairs with `variables` (§B): both are "values that live outside a flow".

## D. Evaluation and insights

**n8n evaluation:** `agent-evals` module (21 files) + eight entities —
`agent-eval-dataset`, `agent-eval-rating`, `agent-eval-result`,
`agent-eval-run`, `evaluation-collection`, `evaluation-config`,
`test-case-execution`, `test-run`. Plus `agent-eval-case-generation.service`,
which **generates eval cases automatically**.

**Sublime evaluation:** `src/lib/eval` — 7 files (`harness`, `judge`,
`scripted-runner`, `from-transcript`, `fixtures`, `types`). Real, and
`from-transcript` is a good idea n8n reaches via `execution-annotation`. But
it is a developer harness run from the CLI: **no datasets, no persisted runs,
no ratings, nothing in the product.**

**n8n insights:** a module with collection, compaction and pruning services
over `workflow-statistics`.

**Sublime:** `FlowLearningObservation` / `FlowLearningFeedback` and the Goal
spine — which is a *better* idea than n8n's insights, because it measures
outcomes rather than executions. But there is no per-flow execution analytics
surface.

**Verdict:** evaluation is the bigger gap of the two. Sublime's agents make
non-deterministic decisions and there is no product-level way to tell whether
a change made them better.

## E. Workflow review

`workflow-reviews.ee` — 26 files, five entities (`request`, `author`,
`reviewer`, `workflows`, `activity`, `activity-comment`), with eligibility,
access and activity services.

This is pull requests for workflows: propose a change, assign reviewers,
comment, approve, publish.

Sublime has `FlowComment` with point anchors and `FlowCollaborator` — good
collaboration *during* editing, nothing gating publish. Combined with §A1
(agents have no draft state at all), **change control is the weakest area of
the platform** relative to n8n.

## F. Source control and environments

`source-control.ee` (48) + `git-connections.ee` (12) + `provisioning.ee` (21)
+ `instance-version-history` (8): git-backed workflow definitions, and
promotion between instances.

Sublime: none. Flows live only in Postgres. There is no export-to-git, no
dev→prod promotion, no way to review a flow diff outside the product.

Note this partly overlaps §E — git-backed flows would give diffs and review
for free, and might be the cheaper route to both.

## G. Extensibility

| n8n | Sublime |
| --- | --- |
| `community-packages` (25 files) — install third-party node packages | none |
| `@n8n/node-cli`, `create-node` — official CLI to author nodes | none |
| `scan-community-package` — static analysis of untrusted packages | n/a |
| `@n8n/workflow-sdk` — build workflows programmatically | none (import/export JSON) |
| `mcp-registry` + `mcp` (171 files) — MCP server + registry | MCP **client** only |

Sublime's node set is closed. Whether that is a gap is a product decision —
a closed set is a security posture, and `scan-community-package` exists
precisely because an open one is not free. **Not recommended.**

The MCP asymmetry is the interesting one: Sublime consumes MCP servers but
does not expose anything over MCP. Serving would let external tools drive
Sublime agents and flows.

## H. Runtime and execution

| Capability | n8n | Sublime |
| --- | --- | --- |
| Execution data model | item-oriented (`INodeExecutionData[]`, `pairedItem`) | value-oriented (`{output: unknown}`) |
| Engine versions | `engine-v2`, `node-engine-compatibility` | single engine |
| Expression runtime | `@n8n/expression-runtime` (isolated), `tournament` | QuickJS `{{js:}}` |
| Task runners | `task-runner`, `task-runner-python` — sandboxed | QuickJS + Pyodide |
| Blob storage | `@n8n/blob-storage` — filesystem, **S3, Azure** | none |
| Partial execution | execute-from-node | `test-node` |
| Pin data | per-workflow | per-**user** *(better)* |
| Dedup | `processed-data` | poll cursor only |
| Wait/resume | wait-tracker | wait + webhook resume |
| Dead-letter | — | **ahead** |
| Dispatch outbox | `workflow-publication-outbox` (publish only) | **ahead** (dispatch) |
| Webhook idempotency | — | **ahead** |
| Concurrency | per-instance | per-queue + loop |
| Breaking-change migrations | `breaking-changes` (95 files) — registry that migrates workflows across node changes | none — §I |
| CRDT collaboration | `@n8n/crdt` | jam + mutation log |
| OTel | `otel` module | Sentry |
| Log streaming | `log-streaming.ee` | — |

## I. Node versioning and breaking changes

66 n8n nodes ship multiple `typeVersion`s, and there is a **95-file
`breaking-changes` module** with a migration registry that rewrites existing
workflows when a node's shape changes.

Sublime models neither. Node params cannot evolve without hand-migrating
every stored graph. This is survivable while node shapes are young and gets
expensive exactly when the product is successful. The declarative param
manifest (in flight) is the natural place to hang a version on — doing it
*before* the manifest ships is much cheaper than after.

## J. Auth and identity

`sso-saml` (30), `sso-oidc` (8), `ldap.ee` (9), `oauth-server` (55),
`oauth-jwe` (13), `token-exchange` (30), `dynamic-credentials.ee` (84).

Sublime: Supabase auth, MFA, capabilities, credential vault.

`oauth-server` is notable — n8n can *act as* an OAuth provider, which is how
external apps get delegated access. Sublime has no third-party access model
at all (see §B, `api-key`).

**SSO/SAML/LDAP is table stakes for enterprise sales** and entirely absent.

---

## Where Sublime leads

Not a consolation section — these are things n8n has no answer for:

- **Goals as the measurement spine** (`Goal`/`GoalWork`/`GoalContribution`,
  measured/estimated/correlated provenance). n8n's insights count executions;
  this measures outcomes.
- **`humanReview`** — first-class mid-run human input.
- **`flow:` tool plane** — an entire flow callable as an agent tool.
- **Dead-letter queues, dispatch outbox, webhook ingress idempotency.**
- **Per-user node pins**, jam comments with point anchors.
- **`errorShield`, `router`, `parallel`, `repeatUntil`, `input`/`output`** —
  no n8n equivalent.
- **Billing and plans** — n8n is self-hosted; Sublime is a product.
- **Graph RAG built into the agent** rather than wired from five sub-nodes.

## Ranked recommendations

Ranked by (user impact × strategic weight) ÷ cost. Deliberately not the same
order as the sections.

**Tier 1 — change control. The weakest area, and cheap relative to impact.**
1. **Agent draft/publish lifecycle.** Agents are live on save; editing a
   production agent changes it mid-flight. Flows already have the pattern
   (`publishedGraph` + `FlowVersion`) — copy it.
2. **Workspace variables (`$vars`).** Every flow hardcodes ids. Small model,
   large daily effect.
3. **`$now` / `$today` expressions.** The most-used n8n expression; today
   needs a `{{js:}}` escape.
4. **Flow `timezone`.** Schedules run on server time — a correctness bug for
   a multi-region workspace, not a preference.
5. **`callerPolicy`.** Any flow is agent-callable via the `flow:` plane with
   no per-flow opt-out. Governance edge.

**Tier 2 — capability**
6. **Evaluation in the product.** Datasets, persisted runs, ratings. The
   harness exists; it is not a feature.
7. **Merge node.** The one core node with no workaround.
8. **Static data / dedup store.** Generalise the poll cursor.
9. **Credential dependency index.** "What breaks if I revoke this."
10. **Form trigger.** Nobody outside the workspace can start a flow.
11. **Model provider seam.** Abstraction is half-built.

**Tier 3 — enterprise**
12. **External secrets** (Vault/AWS/Azure/GCP/Infisical/1Password).
13. **SSO — SAML/OIDC.** Table stakes for enterprise.
14. **Public API + API keys.** Nothing exists.
15. **Node versioning + breaking-change migrations.** Cheaper before the
    param manifest ships than after.
16. **Source control / git-backed flows** — likely also the cheapest route to
    workflow review (§E).
17. **Agent-as-MCP-server.** Sublime consumes MCP; serving inverts it.

**Tier 4 — own spec, own decision**
18. Binary/blob store (S3/Azure) — same decision as the item data model.
19. Paired-item lineage.
20. Email/IMAP trigger, then queue triggers.
21. Embeddings + vector-store seams.

**Explicitly not recommended:** porting the AI sub-node architecture;
migrating to an item-oriented runtime; community/third-party node packages
(a closed node set is a security posture, and n8n needs a static analyser
because an open one is not free).
