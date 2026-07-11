# Gumloop-Parity Orchestration + Subagents — Design Spec

**Date:** 2026-07-11 · **Status:** DRAFT (awaiting user review) · **Guide:** [Gumloop docs](https://docs.gumloop.com) (agents-as-nodes, workflows-as-tools, subagents)

**Goal:** Reach Gumloop-parity workflow orchestration and add first-class **subagents** to the platform: agents that call flows as tools, flows that call flows synchronously, and agents that spawn queued background child agents — each with its own context, budget, code sandbox, and file handoff — inspectable as a batch.

**Architecture (one line):** Give flows a **typed Input/Output contract**, expose flows as tools through the **one shared tool-planes module**, add a synchronous **subflow** node, and convert `run_agent` from inline to **queued background subagents** on the existing BullMQ substrate with a **SubagentBatch board** mirroring `FlowRun`/`FlowRunStep` and a **per-subagent e2b code sandbox** for file handoff + code execution.

---

## 1. Current state — the Gumloop scorecard (from code research)

Two runtimes over one tool universe and one queue substrate:
- **Flows** — pure graph interpreter ([interpret.ts](../../../src/features/flows/interpret.ts)) + stateful runner ([execute-flow.ts](../../../src/features/flows/execute-flow.ts)), 14 node kinds, nested loop/parallel, resume/pause, approvals, retries, per-step `FlowRunStep` persistence. Impure work injected as `RunAgentFn`/`RunActionFn`.
- **Agents** — one durable run loop ([execute-agent.ts](../../../src/features/agents/execute-agent.ts) `runAgentExecution`), tool dispatch via a bindings `Map`, `ask_user` pause/resume, write-approval gate, idempotency replay, cancel, turn/token budgets. Tools from four planes ([tool-planes.ts](../../../src/features/agents/tool-planes.ts)): Klavis MCP, per-org MCP, native, Nango.
- **Substrate** — BullMQ `AGENT_EXECUTION`/`FLOW_EXECUTION` queues + one Render worker + `EXECUTION_MODE` inline↔queue toggle (prod pinned **inline** until Redis+worker land).

| Gumloop capability | Status | Gap |
|---|---|---|
| **Agents-as-nodes** (drop a specialized agent into a flow) | ✅ **have** | The `agent` node runs the real runtime (execute-flow.ts:291-350). Minor: no inline anonymous "run a prompt" node; no Loop-Mode conversation-id threading. |
| **Workflows-as-tools** (agent calls a flow, fills Inputs, reads Outputs) | ❌ **missing** | No `flow` tool plane, no Flow→ToolDefinition adapter. |
| **First-class Input / Output nodes** (typed callable signature) | ⚠️ **partial** | Input is opaque `{{trigger.input}}` + `trigger.inputFields` (not coerced); output is implicit `lastOutput`. |
| **Subagents** (own context/sandbox/time-budget, queued, inspectable) | ⚠️ **partial** | `run_agent` gives own context but runs **inline**, shares org token budget, never enqueues, no wall-clock budget, can't pause, no sandbox. |
| **Synchronous subflow** (nest a flow, block on its Output) | ❌ **missing** | Only fire-and-forget `flow.completed` signals (depth-cap 3), never reads child output. |
| **Progress board for a subagent batch** | ❌ **missing** | `AgentExecution` has no `parentExecutionId`/`depth`/`batchId`; `FlowRun`+`FlowRunStep` is the shape to mirror. |
| **File/artifact handoff + code sandbox** | ❌ **missing** | `run_agent` passes only string in/out; no artifact store; **no sandbox anywhere**. |

## 2. Locked decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Overall approach | **A — contract-first, ride the rails** (reuse tool-planes, interpreter adapters, queue, FlowRun board; no big-bang refactor) |
| Sequencing | **Both tracks in parallel** — Track 1 (flows-as-tools) + Track 2 (subagents), each its own implementation plan |
| Sandbox | **Real per-subagent code sandbox in v1** (e2b-style microVM), not deferred |
| Subagent execution | Queued on `AGENT_EXECUTION` behind `EXECUTION_MODE`; degrades to inline until the Render worker + Redis deploy, then flips with zero rework |

## 3. Track 1 — Flow I/O contract + flows-as-tools + subflow

### 3.1 First-class Input / Output nodes (the prerequisite)
Add two node kinds to the flow graph discriminated union + `execNode` dispatch in [interpret.ts](../../../src/features/flows/interpret.ts):
- **`input` node** — declares named, typed parameters (`{ name, type: string|number|boolean|json, required, default, description }[]`), with precedence **user > webhook > default**. Coerces values at the boundary (unlike today's untyped `trigger.inputFields`). Produces a typed `input.<name>` binding.
- **`output` node** — declares named, typed return fields and binds them from flow context, giving the flow an explicit typed return object (replacing implicit `lastOutput`).

Together these are the flow's **callable signature** — the single change that unlocks flows-as-tools, subflows, and typed webhook contracts. Touches: interpreter, validation, token-resolution, [copilot-grounding.ts](../../../src/lib/flows/copilot-grounding.ts), and the builder palette.

### 3.2 Flow tool plane (workflows-as-tools)
Add a `flow` member to `FlowToolPlane` ([tool-connection-id.ts](../../../src/lib/flows/tool-connection-id.ts)) and a **Flow→ToolDefinition adapter** in [tool-planes.ts](../../../src/features/agents/tool-planes.ts):
- `inputSchema` = the flow's `input`-node fields (typed JSON Schema).
- `execute()` = `dispatchFlowExecution(flowId, args)` → returns the flow's `output`-node object.
- Because tool-planes is the **one module** consumed by both `loadTools` (agent runtime) and the flow tool catalog, flows-as-tools appears for **agents and flows at once**. An org toggles which flows are agent-callable ("Abilities"-style).
- Extend `buildCopilotGrounding` so the flow-builder copilot can wire agent→flow calls.

### 3.3 Subflow node (synchronous flow→flow)
Add a **`subflow`** node that injects a `RunFlowFn` adapter (mirroring how `agent` nodes inject `RunAgentFn`): calls `runFlowExecution` on the child, blocks on its declared `output`, maps it back into parent context, records a `FlowRunStep` linking the child run. Replaces the fire-and-forget `flow.completed` path for the nest-and-wait case. **Nested iteration = subflow-per-loop-item** (matches Gumloop guidance; sidesteps the edgeless-container limit without reworking resume/approval machinery).

## 4. Track 2 — Queued background subagents

### 4.1 Execution: `dispatchAgentExecution`
Convert `run_agent` (execute-agent.ts:596-675) from inline-await to a **`dispatchAgentExecution` wrapper** that enqueues child jobs on the existing `AGENT_EXECUTION` queue with `{ parentExecutionId, depth, batchId, tokenBudget, wallClockBudgetMs, attachments }`, then returns a **handle** the parent polls for completion. Reuses the existing `MAX_SUBAGENT_DEPTH`/`MAX_SUBAGENTS_PER_RUN`/cycle-guard logic — only the mechanism changes (inline→enqueue). Behind `EXECUTION_MODE`: inline until the worker deploys, queued after.

### 4.2 Data model — lineage + board
- `AgentExecution` (schema.prisma:338) gains `parentExecutionId?`, `depth` (default 0), `batchId?` — queryable lineage (today depth lives only in the in-memory job payload).
- New **`SubagentBatch`** (parent-run + membership) mirroring the proven `FlowRun`+`FlowRunStep` board (schema.prisma:714-756): per-subagent live status `queued|running|succeeded|failed|waiting`, order, `agentExecutionId`, result summary — for the inspectable batch view and per-subagent credit grouping.

### 4.3 Budgets
Each subagent gets **its own token cap AND wall-clock budget** as job params, **derived from the parent's remaining budget** (Gumloop: ~half, hard-capped at 1hr) so deep chains self-limit. This is the whole point of moving off inline — independent budgets stop a deep/wide tree from blowing the parent run.

### 4.4 File handoff (via the sandbox — see §5)
Parent places specific files into the subagent's sandbox workspace **before it starts** (attachments on the enqueued job) and reads result artifacts **on completion**. A per-execution artifact store persists inputs/outputs and links them to the `SubagentBatch` member.

## 5. The code sandbox (v1, per user decision)

**Provider:** **e2b** (recommended) — Firecracker microVM sandboxes with a TypeScript SDK, per-sandbox filesystem, file upload/download, and `runCode` (Python/shell), sub-second starts. (Alternatives to weigh at review: Daytona, Modal, self-hosted Firecracker/gVisor. Provider is a **spec-review decision** — cost, data-residency, and self-host vs hosted.)

**Model (mirrors Gumloop):**
- Each subagent conversation gets **its own isolated sandbox** (own filesystem + package env), created on spawn, torn down on completion (or idle-TTL).
- **Isolated, not shared:** coordination is **explicit artifact handoff** — the parent writes specific files into the child's workspace at spawn and reads named result files at completion. No shared mutable filesystem (matches Gumloop).
- A new **`sandbox` tool binding** exposes `run_code(language, source)` / `read_file` / `write_file` / `list_files` to the agent runtime, dispatched like any other tool (no run-loop change).
- **Lives on the worker/serverful side**, not Vercel serverless — sandbox lifecycle needs a persistent caller; ties to the same Render-worker track as queued subagents.

**Security (critical, new surface):**
- Sandboxes run untrusted LLM-authored code — **network egress allowlist**, no platform secrets mounted, per-org isolation, CPU/mem/time limits, and the provider's microVM boundary. Sandbox credentials in env only, never in a repo or prompt.
- All sandbox I/O is org-scoped and audited; artifacts inherit the org's visibility contract.

## 6. Reusable seams (build on, don't rebuild)

| Seam | File | Gives |
|---|---|---|
| Shared tool-planes | [tool-planes.ts](../../../src/features/agents/tool-planes.ts) | one `flow` plane → flows-as-tools for agents + flows at once |
| Agent run loop + bindings | [execute-agent.ts](../../../src/features/agents/execute-agent.ts) | flow-as-tool, queued-subagent, and sandbox bindings all slot in as new `ToolBinding`s |
| Pure interpreter + adapters | [interpret.ts](../../../src/features/flows/interpret.ts) | `input`/`output`/`subflow` node kinds plug into the union; subflow injects `RunFlowFn` |
| Flow→agent adapter + dispatch | [execute-flow.ts](../../../src/features/flows/execute-flow.ts) | the exact create-step→run→link→parse-output→pause/resume pattern to mirror for agent→flow + subflow; `dispatchFlowExecution` is the flow-as-tool `execute()` |
| BullMQ queues + worker + toggle | [queue/config.ts](../../../src/lib/queue/config.ts), [execution-mode.ts](../../../src/lib/queue/execution-mode.ts) | the ready substrate for queued subagents; only `dispatchAgentExecution` is missing |
| FlowRun + FlowRunStep board | [schema.prisma](../../../prisma/schema.prisma) | the exact board shape to mirror as `SubagentBatch` |
| Structured output + copilot grounding | [copilot-grounding.ts](../../../src/lib/flows/copilot-grounding.ts) | `outputFields`/`parseStructuredAgentOutput` is the ready typed read-back for `output` nodes; extend `toolCatalog` for agent→flow |

## 7. Phasing (both tracks parallel, each its own plan)

- **Track 1 — Flow I/O + flows-as-tools + subflow** (no worker/sandbox dependency; ships on current inline prod): §3.1 → §3.2 → §3.3. Independently demoable.
- **Track 2 — Queued subagents + board + budgets** (rides the queue; degrades to inline via toggle): §4.1 → §4.2 → §4.3, with file handoff (§4.4) gated on the sandbox.
- **Track 3 — Code sandbox** (§5): the new infra piece; the file-handoff half of Track 2 depends on it, so Track 2 ships budgets/board/lineage first and wires handoff when the sandbox lands.

Each track becomes its own `writing-plans` plan → subagent-driven-development execution. Track 1 first-to-value; Tracks 2 and 3 proceed in parallel and converge on file handoff.

## 8. Error handling & degradation
- Flow-as-tool / subflow failures surface as tool errors / `FlowRunStep` failures with the existing `onError` semantics; no run crash.
- Queued subagents inherit durable resume/idempotency/cancel from the existing loop. Parent polling handles child timeout, partial-batch failure, and parent-resume-on-child-completion.
- Sandbox unavailable → the `sandbox` tool degrades to an explicit "code execution unavailable" tool error; queued subagents without file handoff still run (string in/out).
- `EXECUTION_MODE=inline` (today) → subagents run inline with a warning that budgets/board are best-effort until the worker deploys.

## 9. Testing strategy
- **Pure/unit:** Input-node type coercion + precedence (user>webhook>default); Output-node binding; Flow→ToolDefinition schema derivation; child-budget derivation from parent remaining; batch state-machine transitions; sandbox path/permission validation.
- **Interpreter:** `input`/`output`/`subflow` nodes via the injected-adapter harness (fake `RunFlowFn`); nested subflow-per-item.
- **Integration (fakes):** flow-as-tool round-trip through a fake tool-plane; `dispatchAgentExecution` enqueue+poll with a fake queue; `SubagentBatch` board aggregation; sandbox handoff with a fake e2b client (write-in → run → read-out), including the no-shared-filesystem isolation assertion.

## 10. Out of scope / deferred
- Router "AI mode" and the full 150+ Gumloop integration-node catalog (we have condition/switch/loop/parallel/filter).
- Giving loop/parallel bodies real edges (use subflow-per-item instead).
- A shared mutable cross-subagent filesystem (Gumloop itself doesn't — explicit handoff only).
- Multi-provider sandbox abstraction (pick one provider for v1).

## 11. Risks & open questions
- **Sandbox provider choice** (e2b vs Daytona vs self-hosted) — cost, data residency, egress control — a spec-review decision.
- **Worker dependency:** queued subagents and the sandbox both need the Render worker + Redis actually deployed to be "real" in prod; until then, inline fallback (no better than status quo for subagents). Sequencing Track 1 first hedges this.
- **Input/Output node migration:** existing flows use implicit input/output — need a back-compat path (a flow with no `input`/`output` node still runs with today's `{{trigger.input}}`/`lastOutput` semantics).
- **Untrusted code execution** is a materially new security surface — the sandbox security model (egress, secrets, limits) must be reviewed before Track 3 ships.
