# Copilot tool loop + streaming replies

**Date:** 2026-08-03
**Status:** Approved design, pending implementation
**Surfaces:** Agents copilot (`/api/agents/[id]/chat`, `assistant-panel.tsx`) and flows copilot (`/api/flows/copilot/chat`, `copilot-panel.tsx`)

## Problem

Both copilots make exactly one `generateStructured` call per turn. Everything the
model will ever know must be assembled into the prompt before the call:

- The agents copilot's context builder (`src/features/agents/assistant-context.ts`)
  fetches full detail for only two runs (latest + latest failed), with tool-call
  inputs clipped to 600 chars and outputs to 800. Ask about any other run and the
  model *correctly* answers "the context does not contain that" — an honest dead
  end where a lookup should be.
- The flows copilot grounds on the roster/tool catalog snapshot only; it cannot
  inspect a flow run, another flow's graph, or a tool's schema beyond the
  first-8-properties hint line.
- Neither route streams. `model-runner.ts` already streams from Anthropic
  internally but blocks on `finalMessage()`; users watch "Thinking…" for up to a
  minute under `maxDuration = 120`.
- Token metering is `(system + user + raw).length / 4` because
  `generateStructured` returns no usage — wrong for cached prefixes and
  multi-byte content, and it is billing data.

## Decisions (made with James, 2026-08-03)

1. **Scope:** one spec, both copilots. Shared loop core + thin per-surface
   adapters. Agents surface ships first, flows second.
2. **Powers:** read-only tools. Every mutation keeps its existing gate — the
   ProposalCard confirm for agents, undoable canvas ops for flows. No re-run /
   test-node actions in this iteration.
3. **Stream detail:** prose tokens as they are written, plus one named activity
   event per tool call ("Reading run 4f2a…").
4. **Hop budget:** up to 6 read-tool calls per turn (~30–45s worst case, inside
   the existing `maxDuration = 120`).
5. **Structured output mechanism:** terminal tool (option A). The loop carries
   read tools plus exactly one terminal tool whose *input schema* is today's
   proposal/ops payload. Investigating and proposing happen in one model
   conversation; no second "now emit the structure" call, and the evidence the
   user watched it read is provably what the proposal was based on.

## Architecture

### Shared core: `src/lib/llm/copilot-loop.ts`

A bounded investigate-then-answer runner on top of the existing
`ModelRunner.next(transcript, system, tools, effort)` contract — the same
machinery `execute-agent.ts` drives, deliberately *not* a second agent
framework.

```ts
runCopilotLoop({
  system: string,
  transcript: unknown[],            // provider-native messages, as today
  readTools: CopilotTool[],         // ToolDefinition + async executor
  terminalTool: ToolDefinition,     // propose_config_change | edit_flow
  maxReadCalls: number,             // 6
  emit: (event: CopilotStreamEvent) => void,
}): Promise<{
  text: string                      // full prose (already emitted as deltas)
  terminalCall: Record<string, unknown> | null
  usage: { inputTokens: number; outputTokens: number }  // summed across hops
  hops: number
}>
```

Loop rules — enforced structurally by the runner, never by prompt alone:

- Each iteration calls `runner.next()`. Text blocks are emitted as `text`
  deltas; a `tool_use` of a read tool executes it, appends the provider-native
  tool result to the transcript, and continues.
- **Hop budget:** after `maxReadCalls` read calls, the tools array passed to
  subsequent `runner.next()` calls shrinks to `[terminalTool]`, and a synthetic
  user message instructs the model to answer with the evidence it has. A model
  that wants a 7th lookup physically cannot make one.
- **Termination:** calling the terminal tool ends the turn; so does `end_turn`
  with no tool call (pure Q&A — nothing to propose). `terminalCall` is the raw
  tool input; the surface validates it with its existing sanitizer.
- **Executor failures are information:** a read-tool executor that throws or
  times out (per-call timeout 10s) produces a `{error}` tool result and the
  loop continues. A failed lookup must not crash the turn.
- **Usage:** summed across all hops and returned, so surfaces call
  `recordTokenUsage` with real numbers. The `chars/4` estimate is deleted.

### Surfaces adapt, not reimplement

Both routes keep their auth wrapper, rate limit, monthly budget check, event
capture (`recordUserEvent`), and persistence exactly as-is, and replace the
single `generateStructured` call with `runCopilotLoop` plus their tool set.

`buildAssistantContext` / `buildCopilotGrounding` still run and still seed the
system prompt — they are the *starting* context; the loop is how the model
reaches past them. Their content may be trimmed later once tools prove out, but
not in this change.

## Read tools

All executors are scoped by `organizationId` and the existing visibility
helpers (`agentReadScope`, `flowReadScope`). Clip limits match today's context
builder unless noted. Tool descriptions tell the model what each returns and
when to use it.

### Agents copilot

| Tool | Input | Returns |
| --- | --- | --- |
| `list_runs` | `status?`, `limit ≤ 20`, `before?` (cursor) | Run summaries for this agent: id, status, startedAt, durationMs, error head |
| `get_run` | `runId` | Full detail for any run of this agent — steps with tool calls and conversation, the same shape `buildAssistantContext` builds for latest/latest-failed today |
| `get_step_output` | `runId`, `stepId` | One step's input/output/error at a ~4k-char clip, for deep inspection past the default 600/800 clips |
| `get_tool_schema` | `connectionId`, `toolName` | The tool's input/output JSON schema from the flow tool catalog |
| `list_workspace_agents` | — | Visible sibling agents: id, name, model, schedule, integrations — for comparison questions |

### Flows copilot

| Tool | Input | Returns |
| --- | --- | --- |
| `list_flow_runs` | `flowId?` (default: current flow), `status?`, `limit ≤ 20` | Run summaries |
| `get_flow_run` | `runId` | Per-node step results: status, input/output heads, error |
| `get_tool_schema` | `connectionId`, `toolName` | Shared implementation with the agents surface |
| `get_flow` | `flowId` | Another visible flow's graph — "make this like my other flow", subflow wiring |

### Terminal tools

- **`propose_config_change`** (agents): input schema is today's proposal object
  (summary, title, description, instructions, model, integrations, skills,
  schedule) minus the `{reply, proposal}` wrapper. Output runs through the
  existing `normalizeProposal`; the ProposalCard confirm flow is unchanged.
- **`edit_flow`** (flows): input is `{message: string, opsJson: string}` —
  the ops-array-as-JSON-string pattern is kept deliberately (Anthropic strict
  schemas cannot express the six heterogeneous op shapes; same rationale as the
  current route, see `strictifySchema`). Output runs through
  `parseCopilotChatReply`-equivalent parsing + `sanitizeCopilotOps` +
  `applyCopilotOps` + `validateFlowGraph`, all unchanged.

## Streaming protocol

`POST` returns `text/event-stream`. `withAuthenticatedApi` already passes raw
`Response` objects through (`api-handler.ts` line 26/127), so auth, rate
limiting, and error mapping stay in the wrapper.

Events, in order:

```text
{type: 'text',   delta: string}                          // prose tokens, repeated
{type: 'tool',   name: string, label: string}            // one per hop; label is server-built, human ("Reading run 4f2a…")
{type: 'result', ...surface payload, messageId: string}  // always last on success
{type: 'error',  message: string, code?: string}         // terminal failure
```

- `result` carries exactly what the JSON body carries today (agents: reply +
  proposal + messageId; flows: message + ops + needsAttention), so client
  apply/confirm logic is untouched.
- Tool `label`s are constructed server-side from the tool name + input — the
  model does not author them.
- **Non-streaming fallback:** `Accept: application/json` buffers the turn and
  returns today's response shape. Existing tests and any non-UI callers keep
  working; the fallback also de-risks rollout (server can ship before clients).
- Budget/rate-limit rejections happen before the stream opens → plain 4xx JSON
  exactly as today.

## Client changes

Shared hook `useCopilotStream` (new, small) consumed by `assistant-panel.tsx`
and `copilot-panel.tsx`:

- `text` deltas render into the in-progress assistant bubble.
- `tool` events render as a transient activity line beneath the bubble; when
  the turn completes they collapse into a compact "investigated N things"
  affordance that expands to the list of labels.
- `result` hands the payload to the existing handlers (ProposalCard render /
  ops application + needsAttention).
- "Thinking…" appears only before the first event arrives.

## Failure modes

- **Stream drops mid-turn** (deploy, network): client shows "Connection lost —
  resend?" and preserves the user's message in the composer. Message
  persistence remains atomic per turn server-side, as today.
- **Invalid terminal payload:** existing sanitizers strip/repair; `result`
  carries the honest "couldn't apply" language the flows route already has.
- **Provider failover mid-loop:** transcripts are provider-native, so the turn
  restarts on the fallback provider rather than splicing transcripts
  (`structuredProviderOrder` reused at loop start). One retry, then `error`.
- **Runaway model:** hop budget is structural (tools array shrinks); the
  existing `maxDuration = 120` and per-executor 10s timeouts bound the rest.

## Testing

Mirrors the repo's e2e pattern — fake SSE Anthropic servers already exist as
prior art in `src/app/api/__tests__/`.

1. **Loop unit tests** (scripted fake `ModelRunner`): hop budget shrinks the
   tools array after N read calls; terminal call ends the turn; `end_turn`
   with no tool call ends the turn; executor error becomes an `{error}` tool
   result and the loop continues; usage sums across hops.
2. **Route e2e per surface** (fake provider): SSE event ordering
   (`text* / tool*` interleaved, `result` last); non-streaming fallback body
   carries the same fields as today's contract; **visibility scoping — org A's
   copilot cannot read org B's runs/flows/agents through any tool** (the
   security-critical test); budget rejection precedes the stream.
3. **Existing chat-route tests** keep passing unmodified via the JSON fallback
   until the clients switch.

## Sequencing

1. `copilot-loop.ts` + agents surface (route + tools + SSE) + agents client.
2. Flows surface + client, reusing the core and `get_tool_schema`.
3. Delete the dead single-shot paths and the `chars/4` metering.

Each step lands green independently.

## Out of scope (deliberately)

- Re-run / test-node as confirmed actions (powers decision #2 — next iteration).
- Diff-style proposal rendering, cross-surface grounding for the agents
  copilot, proactive failure-openers, new flow ops — items 3–8 of the
  assessment this spec came from.
- Any change to the home dashboard assistant (`/api/assistant/chat`); it can
  adopt the loop later but is not part of this spec.
