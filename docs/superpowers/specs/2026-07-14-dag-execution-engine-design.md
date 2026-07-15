# DAG Execution Engine (Sub-project ① of Free-Form DAG Flows) — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorming session with owner)
**Parent project:** Free-form DAG flow builder. ① engine (this spec) → ② free-form
canvas → ③ migration & polish.

## Problem

The flow builder is **linear**. `interpretFlow` walks a single chain — at each
node it takes ONE outgoing edge (`outgoing(id, branch)`) — so a graph cannot
express:

- **Fan-out:** one node feeding several downstream nodes that run *simultaneously*.
- **Fan-in / join:** several nodes (e.g. 3 API calls) converging into one node.
- **Selective routing:** API-1 feeding Agent-A only, while API-3 feeds Agent-B.

Consequently a node's context is decided by *position*, not by *wiring*: the
`{{upstream}}` aggregate (shipped in `2026-07-14-flow-upstream-aggregation-design.md`)
hands an agent **every** prior data-bearing node's output, with no way to say
"only these sources feed this agent."

The owner's requirement: *"multiple APIs feed two or three agents simultaneously,
or certain APIs only feed certain agents — DAG style allows this connectivity."*

## Goals

1. Execute an arbitrary **DAG**: multiple parents and multiple children per node.
2. **Concurrency:** independent nodes run at the same time (bounded).
3. **Joins:** a node runs once, after all its parents settle — with **partial
   data** when a feeder failed (resilient).
4. **Edge-scoped context:** a node's `{{upstream}}` becomes its transitive
   **graph-ancestors** — the nodes actually wired into it. This is what makes
   selective routing real.
5. **Zero regression:** a linear flow is a DAG where every node has ≤1 parent, so
   every existing flow must behave identically.

## Non-goals

- **The free-form canvas UI** — that is sub-project ② (this spec is engine-only;
  DAG graphs can be hand-authored/tested without it).
- **Removing the `loop` / `parallel` / `errorShield` containers.** They stay
  exactly as they are and participate in the DAG as ordinary single nodes
  (their internal traversal is untouched). Folding `parallel` into pure DAG
  topology is a possible ③ cleanup, deliberately out of scope here.
- Cycles / looping-back edges (a DAG is acyclic by definition; `repeatUntil` and
  `loop` remain the iteration primitives).

## Current architecture

- `interpretFlow(graph, input, opts)` (`src/features/flows/interpret.ts`, ~1,070
  lines) starts at the trigger and follows a single chain via
  `outgoing(id, branch)`; `execNode(node, ctx)` runs one node and records
  `ctx.step[nodeId] = { output }`.
- Branch nodes (`condition`/`switch`/`router`) pick a branch label; the walker
  follows the matching edge.
- Containers (`loop`/`parallel`/`errorShield`) own their body traversal.
- `ctx.upstream` is rebuilt per node from **all** of `ctx.step` (data-bearing
  types only) — see `buildUpstream`.
- Resume: `opts.completed` (key → output) replays finished steps;
  `resumeKey`/`resumeNodeId` marks the single paused node to re-run.
- Execution is strictly sequential.

## Design

### 1. Graph model & validation

No schema change is required — `FlowEdge` is already `{ id, source, target,
branch? }`, so many→many wiring is *representable* today; only the walker is
linear. We add derived structure + validation:

- **Adjacency:** build `parentsOf: Map<nodeId, FlowEdge[]>` and
  `childrenOf: Map<nodeId, FlowEdge[]>` once per run (container-body nodes are
  excluded — they are owned by their container, not the top-level DAG).
- **Acyclicity:** detect cycles via DFS/Kahn during validation
  (`src/lib/flows/validate.ts`) and at run start. A cycle fails with a clear
  message naming the participating nodes.
- **Entry:** nodes with no parents (in practice the trigger).

### 2. Scheduler (replaces the single-chain walk)

A dependency scheduler drives the top-level graph:

- Each node has a state: `pending → ready → running → settled(succeeded |
  skipped | failed-continued)`, or `pruned`.
- A node becomes **ready** when every incoming **active** edge's source has
  settled, and at least one incoming active edge exists (entry nodes are ready
  immediately).
- All ready nodes run **concurrently**, bounded by a cap
  (`maxConcurrency`, default 8, reusing the existing `mapLimit` helper). As each
  settles, its children are re-evaluated for readiness.
- The run ends when no node is running and none is ready. The step budget
  (`maxSteps`) and existing per-node retry/timeout behavior are unchanged.

**Branch pruning.** `condition`/`switch`/`router` still select a branch label.
Outgoing edges whose `branch` does not match the selection become **pruned**. A
node all of whose incoming edges are pruned (and which has no active parent) is
itself `pruned`, and pruning propagates transitively. This preserves today's
"only the taken branch runs" semantics inside a DAG, while still letting two
branches legitimately re-converge on a shared downstream node.

**Determinism.** Concurrency changes *timing*, not results: node outputs are
keyed by id, and `steps[]` is sorted by settle order. For a linear graph the
schedule is identical to today's walk.

### 3. Join semantics (owner decision: resilient)

- A node with several parents runs **once**, after all parents settle
  (wait-for-all barrier) — never once per parent.
- **Run with partial data:** parents that failed *and continued*
  (`onError: 'continue'`) contribute their recorded
  `{ ok: false, error }` (the capture-hardening already shipped), and the join
  still runs. The downstream agent reasons over what's available.
- A parent that fails with `onError: 'stop'` still aborts the run (unchanged
  semantics) — the join never runs. "Partial data" is expressed by feeders
  opting into `continue`.
- A join whose parents are **all** pruned is itself pruned.

### 4. Edge-scoped context (re-scopes the shipped aggregation)

- `buildUpstream(ctx)` changes from "all data-bearing steps executed so far" to
  "**this node's transitive ancestors**" — computed from `parentsOf` (memoized
  per node per run). `excludeFromContext` and the size cap are unchanged.
- Effect: Agent-A wired to API-1+API-2 sees exactly those; Agent-B wired to
  API-3 sees only that. The `{{upstream}}` token, the agent auto-append
  (default-input agents), `includeUpstream`, and `serializeUpstream` are all
  unchanged in behavior — only the *set* they draw from narrows.
- **Back-compat:** in a linear chain, a node's ancestors ARE every prior node, so
  existing flows see an identical bundle.

### 5. Failure propagation

- `onError: 'stop'` → the run fails (as today); in-flight sibling nodes are
  allowed to settle, then the run reports the first failure.
- `onError: 'continue'` → the node settles as `failed-continued` with
  `{ ok:false, error }` recorded; descendants proceed.
- A `stop` node terminates the run; in-flight siblings settle first.

### 6. Pause / resume with concurrency (the risky corner)

Today's model assumes exactly one paused node. With concurrent branches, an
agent can pause for approval while siblings are still running.

- **On pause:** the pausing node records its waiting state. The scheduler stops
  admitting *new* nodes, lets in-flight nodes settle, then returns a
  `pause` result carrying **every** settled node's output plus the paused
  node(s). Nothing is lost.
- **On resume:** `opts.completed` replays settled nodes (they are marked
  `settled` and their outputs restored into `ctx.step` without re-execution —
  today's behavior), the DAG is rebuilt, the paused node re-runs with its reply,
  and the scheduler resumes from the resulting frontier.
- **Multiple simultaneous pauses** are possible in a DAG. v1 keeps the existing
  single-`resumeKey` contract by admitting **one** pause per run: the first node
  to pause wins; other branches settle and the run pauses. (Multi-pause resume is
  a follow-up; called out explicitly rather than half-built.)
- `completedKey`/`iterationPath` semantics are unchanged (container bodies still
  own their iteration keys).

### 7. Shared mutable state under concurrency

- `ctx.step` is keyed by node id — concurrent writers touch disjoint keys (safe).
- `ctx.variables` is a **shared** map. Concurrent `variable` writes on
  independent branches are inherently racy; v1 documents this (last-writer-wins,
  as with the existing `parallel` container) and does not add locking.

## Testing

- **Scheduler:** fan-out runs children concurrently; fan-in runs the join once
  after all parents; diamond (A→B,C→D) executes D exactly once; a linear graph
  produces the identical step order/output as today.
- **Joins:** resilient join runs with a `continue`-failed parent and sees
  `{ok:false,error}`; a `stop`-failed parent aborts before the join; all-pruned
  parents ⇒ pruned join.
- **Branch pruning:** condition/switch/router prune untaken subtrees; two
  branches re-converging on one node still run it once.
- **Edge-scoped context:** Agent-A sees only its wired ancestors, Agent-B only
  its own; a linear chain yields the pre-change bundle (regression guard).
- **Validation:** a cycle fails with a clear, node-naming message.
- **Resume:** settled nodes are not re-executed; the paused node re-runs with its
  reply; the frontier continues correctly.
- **Regression:** the entire existing interpreter suite must pass unchanged.

## Rollout / risk

- The scheduler is a genuine rewrite of the top-level traversal — the highest
  risk in this project. Mitigation: containers, `execNode`, retries/timeouts,
  and resume-replay are all reused as-is; only *which node runs when* changes.
  The existing interpreter suite is the regression gate and must stay green
  without edits.
- Edge-scoped context is a narrowing of an already-shipped feature and is
  behavior-identical for linear flows.
- Ships behind no flag: a linear graph is a DAG, so correctness is proven by the
  existing suite plus the new DAG tests.
