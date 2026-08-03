# Copilot Tool Loop + Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agents and flows copilots a bounded (6-hop) read-tool loop with SSE-streamed replies, replacing their single-shot `generateStructured` calls, per `docs/superpowers/specs/2026-08-03-copilot-tool-loop-streaming-design.md`.

**Architecture:** A shared loop runner (`src/lib/llm/copilot-loop.ts`) drives the existing `ModelRunner.next()` contract with read tools plus one terminal tool per surface (`propose_config_change` / `edit_flow`). Routes stream `text`/`tool`/`result`/`error` events over SSE through the existing `withAuthenticatedApi` wrapper, with an `Accept: application/json` fallback that preserves today's response shapes. All mutations keep their existing confirm gates.

**Tech Stack:** Next.js 15 route handlers, Anthropic SDK streaming (already wrapped by `model-runner.ts`), Prisma, zod, `node:test` + `tsx` (existing test harness), fake SSE provider servers (existing pattern in `src/app/api/__tests__/`).

## Global Constraints

- Hop budget: `maxReadCalls = 6` per turn, enforced structurally (tools array shrinks), never by prompt alone.
- Read tools are read-only. No mutation tools of any kind in this iteration.
- Every read-tool executor is scoped by `organizationId` plus the existing visibility helpers (`agentReadScope`, `flowReadScope`). A cross-org read is a test failure, not a code-review nit.
- Per-executor timeout: 10 000 ms. Executor failure becomes an `{error}` tool result; it must never throw out of the loop.
- `maxDuration = 120` stays on both routes.
- SSE events are exactly: `{type:'text',delta}`, `{type:'tool',name,label}`, `{type:'result',...}`, `{type:'error',message,code?}`. `result` is always last on success.
- Non-streaming fallback: a request without `Accept: text/event-stream` gets today's JSON contract (same fields). Existing tests must keep passing unmodified until the clients switch.
- Token metering uses real summed `usage` from `ModelTurn`; the `chars/4` estimates in both routes are deleted.
- Existing gates unchanged: auth wrappers, rate limits (`agent-chat` perUser 30, `flow-copilot` perUser 30), monthly budget check, `recordUserEvent` capture, message persistence, ProposalCard confirm (agents), sanitize/apply/validate pipeline (flows).
- Plain JavaScript-in-TypeScript repo conventions: no new dependencies. Run tests with `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <file>`.
- DB-backed route tests follow the existing `seedTestOrg`/`installTestAuth` pattern from `src/lib/server/__tests__/test-auth` (see `src/app/api/__tests__/agent-stop-reason-e2e.test.ts` as the reference).

---

### Task 1: Text-delta hook on ModelRunner

The loop must stream prose tokens as the model writes them. `AnthropicProvider.next` already uses `client.messages.stream(...)` but only awaits `finalMessage()`. Add an optional hooks parameter that surfaces the SDK's `text` events. Existing callers (`execute-agent.ts` and tests) pass nothing and are unaffected.

**Files:**
- Modify: `src/lib/llm/model-runner.ts` (interface `ModelRunner` ~line 51, interface `Provider` ~line 119, `AnthropicProvider.next` ~line 133, `AgentRunner.next` ~line 225)
- Test: `src/lib/llm/__tests__/model-runner-hooks.test.ts` (create)

**Interfaces:**
- Consumes: existing `ModelRunner`, `ModelTurn`, `ToolDefinition` types.
- Produces: `export type ModelHooks = { onTextDelta?: (delta: string) => void }` and the extended signature `next(transcript, system, tools, effort?, hooks?)` — Task 2 passes `hooks` through `runCopilotLoop`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/model-runner-hooks.test.ts`. It boots a fake Anthropic-wire SSE server (same env-injection trick as `agent-stop-reason-e2e.test.ts`: point the Qwen endpoint at it), calls `createModelRunner().next(...)` with an `onTextDelta` hook, and asserts the deltas arrived before `finalMessage` resolved the turn.

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

let server: http.Server

function sseTextMessage(chunks: string[]): string {
  const events: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'qwen-test', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ...chunks.map((chunk): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      void raw
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sseTextMessage(['Hel', 'lo ', 'world']))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  process.env.QWEN_API_KEY = 'test-key'
  process.env.QWEN_BASE_URL = `http://127.0.0.1:${port}`
  process.env.QWEN_MODEL = 'qwen-test'
  delete process.env.ANTHROPIC_API_KEY
})

after(async () => {
  delete process.env.QWEN_API_KEY
  delete process.env.QWEN_BASE_URL
  delete process.env.QWEN_MODEL
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('onTextDelta receives streamed text before the turn resolves', async () => {
  const { createModelRunner } = await import('@/lib/llm/model-runner')
  const runner = createModelRunner('qwen-3.7')
  const deltas: string[] = []
  const transcript = runner.start('hi')
  const turn = await runner.next(transcript, 'You are a test.', [], undefined, {
    onTextDelta: (delta) => deltas.push(delta),
  })
  assert.deepEqual(deltas, ['Hel', 'lo ', 'world'])
  assert.equal(turn.text, 'Hello world')
  assert.equal(turn.usage.outputTokens, 7)
})

test('next() without hooks still works (backward compatibility)', async () => {
  const { createModelRunner } = await import('@/lib/llm/model-runner')
  const runner = createModelRunner('qwen-3.7')
  const transcript = runner.start('hi')
  const turn = await runner.next(transcript, 'You are a test.', [])
  assert.equal(turn.text, 'Hello world')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/llm/__tests__/model-runner-hooks.test.ts`
Expected: FAIL — the first test's `deltas` array is empty (hook parameter doesn't exist yet, extra args are silently ignored by JS). If TypeScript refuses to compile the extra argument first, that is also the expected failure.

- [ ] **Step 3: Implement the hook**

In `src/lib/llm/model-runner.ts`:

Add the type next to `ToolDefinition` (~line 18):

```ts
/** Optional per-call streaming hooks. Absent for batch callers (agent runs). */
export type ModelHooks = { onTextDelta?: (delta: string) => void }
```

Extend the `ModelRunner` interface method (~line 56):

```ts
  next(transcript: unknown[], system: string, tools: ToolDefinition[], effort?: Effort, hooks?: ModelHooks): Promise<ModelTurn>
```

Extend the private `Provider` interface identically (~line 121).

In `AnthropicProvider.next` (~line 133), accept `hooks?: ModelHooks` as the fifth parameter and register the SDK listener right after `const stream = this.client.messages.stream({...})`:

```ts
    if (hooks?.onTextDelta) stream.on('text', hooks.onTextDelta)
```

In `AgentRunner.next` (~line 225), accept and forward the parameter:

```ts
  async next(transcript: unknown[], system: string, tools: ToolDefinition[], effort?: Effort, hooks?: ModelHooks): Promise<ModelTurn> {
    ...
        return await provider.next(ir, system, tools, effort, hooks)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/llm/__tests__/model-runner-hooks.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — expected clean (existing 4-arg callers still satisfy the optional 5th param).

```bash
git add src/lib/llm/model-runner.ts src/lib/llm/__tests__/model-runner-hooks.test.ts
git commit -m "feat(llm): optional onTextDelta hook on ModelRunner.next"
```

---

### Task 2: The shared copilot loop

**Files:**
- Create: `src/lib/llm/copilot-loop.ts`
- Test: `src/lib/llm/__tests__/copilot-loop.test.ts` (create)

**Interfaces:**
- Consumes: `ModelRunner`, `ModelTurn`, `ToolDefinition`, `ModelHooks`, `Effort` from `@/lib/llm/model-runner` (Task 1).
- Produces (used by Tasks 4/5/7/8):

```ts
export type CopilotTool = {
  definition: ToolDefinition
  /** Human-readable activity line, built server-side from the input. */
  label: (input: Record<string, unknown>) => string
  execute: (input: Record<string, unknown>) => Promise<unknown>
}

export type CopilotStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; label: string }
  | { type: 'result'; [key: string]: unknown }
  | { type: 'error'; message: string; code?: string }

export type CopilotLoopResult = {
  text: string
  terminalCall: Record<string, unknown> | null
  usage: { inputTokens: number; outputTokens: number }
  hops: number
}

export async function runCopilotLoop(opts: {
  runner: ModelRunner
  system: string
  transcript: unknown[]
  readTools: CopilotTool[]
  terminalTool: ToolDefinition
  maxReadCalls?: number   // default 6
  effort?: Effort
  emit: (event: CopilotStreamEvent) => void
}): Promise<CopilotLoopResult>
```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/llm/__tests__/copilot-loop.test.ts` with a scripted fake `ModelRunner` — no network, no DB:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelRunner, ModelTurn, ToolDefinition, ToolResult } from '@/lib/llm/model-runner'
import { runCopilotLoop, type CopilotStreamEvent, type CopilotTool } from '@/lib/llm/copilot-loop'

const TERMINAL: ToolDefinition = { name: 'propose_config_change', description: 'terminal', inputSchema: { type: 'object' } }

function readTool(name: string, executor?: (input: Record<string, unknown>) => Promise<unknown>): CopilotTool {
  return {
    definition: { name, description: `read ${name}`, inputSchema: { type: 'object' } },
    label: (input) => `${name}(${JSON.stringify(input)})`,
    execute: executor ?? (async () => ({ ok: true })),
  }
}

/** A runner that replays a scripted list of turns and records what it was given. */
function scriptedRunner(turns: Array<Partial<ModelTurn>>) {
  const calls: { tools: ToolDefinition[][]; toolResults: ToolResult[][] } = { tools: [], toolResults: [] }
  let i = 0
  const runner: ModelRunner = {
    model: 'scripted',
    start: (input: string) => [{ role: 'user', content: input }],
    appendUserMessage: (transcript, content) => { (transcript as unknown[]).push({ role: 'user', content }) },
    appendToolResults: (transcript, results) => {
      calls.toolResults.push(results)
      ;(transcript as unknown[]).push({ role: 'tool_results', results })
    },
    next: async (_transcript, _system, tools) => {
      calls.tools.push(tools)
      const turn = turns[Math.min(i, turns.length - 1)]
      i += 1
      return {
        text: turn.text ?? '',
        toolCalls: turn.toolCalls ?? [],
        usage: turn.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: turn.stopReason ?? 'end_turn',
      }
    },
  }
  return { runner, calls }
}

function collectEvents() {
  const events: CopilotStreamEvent[] = []
  return { events, emit: (event: CopilotStreamEvent) => events.push(event) }
}

test('pure Q&A: end_turn with no tool calls ends the loop with null terminalCall', async () => {
  const { runner } = scriptedRunner([{ text: 'All good.', stopReason: 'end_turn' }])
  const { events, emit } = collectEvents()
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [readTool('get_run')], terminalTool: TERMINAL, emit,
  })
  assert.equal(result.text, 'All good.')
  assert.equal(result.terminalCall, null)
  assert.equal(result.hops, 0)
  assert.deepEqual(events.filter((e) => e.type === 'tool'), [])
})

test('terminal tool call ends the loop and returns its input', async () => {
  const { runner } = scriptedRunner([
    { toolCalls: [{ id: 't1', name: 'get_run', input: { runId: 'r1' } }], stopReason: 'tool_use' },
    { text: 'Proposing.', toolCalls: [{ id: 't2', name: 'propose_config_change', input: { summary: 'x' } }], stopReason: 'tool_use' },
  ])
  const { events, emit } = collectEvents()
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [readTool('get_run')], terminalTool: TERMINAL, emit,
  })
  assert.deepEqual(result.terminalCall, { summary: 'x' })
  assert.equal(result.hops, 1)
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => (e as { name: string }).name), ['get_run'])
})

test('hop budget: after maxReadCalls the model only sees the terminal tool', async () => {
  const read = { toolCalls: [{ id: 'x', name: 'get_run', input: {} }], stopReason: 'tool_use' as const }
  const { runner, calls } = scriptedRunner([read, read, read, { text: 'Done.', stopReason: 'end_turn' as const }])
  const { emit } = collectEvents()
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [readTool('get_run')], terminalTool: TERMINAL, maxReadCalls: 2, emit,
  })
  assert.equal(result.hops, 2)
  // Call 1 and 2 offer read+terminal; after budget exhausts, only terminal.
  assert.equal(calls.tools[0].length, 2)
  assert.equal(calls.tools[1].length, 2)
  assert.deepEqual(calls.tools[2].map((t) => t.name), ['propose_config_change'])
})

test('executor failure becomes an {error} tool result and the loop continues', async () => {
  const { runner, calls } = scriptedRunner([
    { toolCalls: [{ id: 't1', name: 'get_run', input: {} }], stopReason: 'tool_use' },
    { text: 'Recovered.', stopReason: 'end_turn' },
  ])
  const { emit } = collectEvents()
  const failing = readTool('get_run', async () => { throw new Error('db exploded') })
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [failing], terminalTool: TERMINAL, emit,
  })
  assert.equal(result.text, 'Recovered.')
  assert.equal(calls.toolResults[0][0].isError, true)
  assert.match(String(calls.toolResults[0][0].content), /db exploded/)
})

test('unknown (hallucinated) tool names get error results, do not count as hops', async () => {
  const { runner, calls } = scriptedRunner([
    { toolCalls: [{ id: 't1', name: 'made_up_tool', input: {} }], stopReason: 'tool_use' },
    { text: 'Ok.', stopReason: 'end_turn' },
  ])
  const { emit } = collectEvents()
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [readTool('get_run')], terminalTool: TERMINAL, emit,
  })
  assert.equal(result.hops, 0)
  assert.equal(calls.toolResults[0][0].isError, true)
})

test('usage sums across hops', async () => {
  const { runner } = scriptedRunner([
    { toolCalls: [{ id: 't1', name: 'get_run', input: {} }], stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 10 } },
    { text: 'Done.', stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 20 } },
  ])
  const { emit } = collectEvents()
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [readTool('get_run')], terminalTool: TERMINAL, emit,
  })
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 30 })
})

test('prose from every turn is concatenated into result.text', async () => {
  const { runner } = scriptedRunner([
    { text: 'Looking at the run.', toolCalls: [{ id: 't1', name: 'get_run', input: {} }], stopReason: 'tool_use' },
    { text: 'The run failed on auth.', stopReason: 'end_turn' },
  ])
  const { emit } = collectEvents()
  const result = await runCopilotLoop({
    runner, system: 's', transcript: runner.start('q'),
    readTools: [readTool('get_run')], terminalTool: TERMINAL, emit,
  })
  assert.equal(result.text, 'Looking at the run.\n\nThe run failed on auth.')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/llm/__tests__/copilot-loop.test.ts`
Expected: FAIL — `Cannot find module '@/lib/llm/copilot-loop'`.

- [ ] **Step 3: Implement `src/lib/llm/copilot-loop.ts`**

```ts
import type { Effort, ModelRunner, ToolDefinition, ToolResult } from '@/lib/llm/model-runner'

/**
 * Bounded investigate-then-answer runner shared by the copilot chat routes.
 * See docs/superpowers/specs/2026-08-03-copilot-tool-loop-streaming-design.md.
 *
 * Structural guarantees (never prompt-enforced):
 * - At most maxReadCalls read-tool executions per turn; once spent, the model
 *   is only offered the terminal tool, so a 7th lookup is impossible.
 * - Executor failures/timeouts become {error} tool results; a failed lookup
 *   is information for the model, not a crashed turn.
 * - The terminal tool's input is returned raw; the SURFACE validates it with
 *   its existing sanitizer. This module never trusts model output.
 */

export type CopilotTool = {
  definition: ToolDefinition
  /** Human-readable activity line, built server-side from the input. */
  label: (input: Record<string, unknown>) => string
  execute: (input: Record<string, unknown>) => Promise<unknown>
}

export type CopilotStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; label: string }
  | { type: 'result'; [key: string]: unknown }
  | { type: 'error'; message: string; code?: string }

export type CopilotLoopResult = {
  text: string
  terminalCall: Record<string, unknown> | null
  usage: { inputTokens: number; outputTokens: number }
  hops: number
}

const EXECUTOR_TIMEOUT_MS = 10_000
/** Executor payloads are model context — clip so one fat row can't blow the window. */
const RESULT_CLIP = 16_000

function clip(text: string): string {
  return text.length > RESULT_CLIP ? `${text.slice(0, RESULT_CLIP)}… [truncated]` : text
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Tool timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runCopilotLoop(opts: {
  runner: ModelRunner
  system: string
  transcript: unknown[]
  readTools: CopilotTool[]
  terminalTool: ToolDefinition
  maxReadCalls?: number
  effort?: Effort
  emit: (event: CopilotStreamEvent) => void
}): Promise<CopilotLoopResult> {
  const { runner, system, transcript, readTools, terminalTool, emit, effort } = opts
  const maxReadCalls = opts.maxReadCalls ?? 6
  const toolsByName = new Map(readTools.map((tool) => [tool.definition.name, tool]))
  const usage = { inputTokens: 0, outputTokens: 0 }
  const prose: string[] = []
  let hops = 0

  // Worst case: one read per iteration, then one forced-answer iteration.
  const maxIterations = maxReadCalls + 2
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const offered =
      hops >= maxReadCalls
        ? [terminalTool]
        : [...readTools.map((tool) => tool.definition), terminalTool]

    const turn = await runner.next(transcript, system, offered, effort, {
      onTextDelta: (delta) => emit({ type: 'text', delta }),
    })
    usage.inputTokens += turn.usage.inputTokens
    usage.outputTokens += turn.usage.outputTokens
    if (turn.text) prose.push(turn.text)

    const terminal = turn.toolCalls.find((call) => call.name === terminalTool.name)
    if (terminal) {
      return { text: prose.join('\n\n'), terminalCall: terminal.input, usage, hops }
    }
    if (turn.toolCalls.length === 0) {
      // end_turn / max_tokens with no tool call: the prose is the answer.
      return { text: prose.join('\n\n'), terminalCall: null, usage, hops }
    }

    // Execute every requested read (or reject unknown names) so each tool_use
    // gets a matching tool_result — Anthropic requires the pairing.
    const results: ToolResult[] = []
    for (const call of turn.toolCalls) {
      const tool = toolsByName.get(call.name)
      if (!tool || hops >= maxReadCalls) {
        results.push({
          toolCallId: call.id,
          content: JSON.stringify({ error: tool ? 'Lookup budget exhausted — answer with what you have.' : `Unknown tool: ${call.name}` }),
          isError: true,
        })
        continue
      }
      hops += 1
      emit({ type: 'tool', name: call.name, label: tool.label(call.input) })
      try {
        const value = await withTimeout(tool.execute(call.input), EXECUTOR_TIMEOUT_MS)
        results.push({ toolCallId: call.id, content: clip(JSON.stringify(value ?? null)), isError: false })
      } catch (error) {
        results.push({
          toolCallId: call.id,
          content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          isError: true,
        })
      }
    }
    runner.appendToolResults(transcript, results)
  }

  return { text: prose.join('\n\n'), terminalCall: null, usage, hops }
}
```

Note: `ToolResult` must be exported from `model-runner.ts` — check with `grep -n "export type ToolResult" src/lib/llm/model-runner.ts`. If it is not exported, export it (it is already a named type used by `appendToolResults`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/llm/__tests__/copilot-loop.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/lib/llm/copilot-loop.ts src/lib/llm/__tests__/copilot-loop.test.ts src/lib/llm/model-runner.ts
git commit -m "feat(llm): bounded copilot read-tool loop with stream events"
```

---

### Task 3: SSE response helper + client stream parser

Two tiny transport modules — server-side event encoding and client-side event decoding — so both surfaces share one wire format.

**Files:**
- Create: `src/lib/server/sse.ts`
- Create: `src/lib/client/copilot-stream.ts`
- Test: `src/lib/server/__tests__/sse.test.ts` (create)
- Test: `src/lib/client/__tests__/copilot-stream.test.ts` (create)

**Interfaces:**
- Consumes: `CopilotStreamEvent` shape (structurally — no import needed client-side).
- Produces:

```ts
// src/lib/server/sse.ts
export function sseResponse(run: (emit: (event: object) => void) => Promise<void>): Response

// src/lib/client/copilot-stream.ts
export type CopilotStreamCallbacks = {
  onText?: (delta: string) => void
  onTool?: (activity: { name: string; label: string }) => void
}
export type CopilotStreamOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; code?: string; status?: number }
export async function streamCopilot(
  url: string,
  body: unknown,
  callbacks: CopilotStreamCallbacks,
): Promise<CopilotStreamOutcome>
```

- [ ] **Step 1: Write the failing server test**

Create `src/lib/server/__tests__/sse.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sseResponse } from '../sse'

async function readAll(response: Response): Promise<string> {
  return await new Response(response.body).text()
}

test('encodes each emitted event as a data: line', async () => {
  const response = sseResponse(async (emit) => {
    emit({ type: 'text', delta: 'hi' })
    emit({ type: 'result', ok: true })
  })
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const bodyText = await readAll(response)
  assert.equal(bodyText, 'data: {"type":"text","delta":"hi"}\n\ndata: {"type":"result","ok":true}\n\n')
})

test('a thrown handler becomes a terminal error event, not a broken stream', async () => {
  const response = sseResponse(async (emit) => {
    emit({ type: 'text', delta: 'partial' })
    throw new Error('model exploded')
  })
  const bodyText = await readAll(response)
  assert.match(bodyText, /"type":"error"/)
  assert.match(bodyText, /model exploded/)
})
```

- [ ] **Step 2: Write the failing client test**

Create `src/lib/client/__tests__/copilot-stream.test.ts`. No DOM needed — mock `globalThis.fetch` with synthetic `Response` objects:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { streamCopilot } from '../copilot-stream'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function sseFetch(chunks: string[], init?: { status?: number; contentType?: string }) {
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    return new Response(stream, {
      status: init?.status ?? 200,
      headers: { 'Content-Type': init?.contentType ?? 'text/event-stream' },
    })
  }) as typeof fetch
}

test('parses text, tool, and result events across chunk boundaries', async () => {
  // Deliberately split one event across two network chunks.
  sseFetch([
    'data: {"type":"text","delta":"Hel"}\n\ndata: {"type":"te',
    'xt","delta":"lo"}\n\ndata: {"type":"tool","name":"get_run","label":"Reading run r1"}\n\n',
    'data: {"type":"result","reply":"done"}\n\n',
  ])
  const texts: string[] = []
  const tools: string[] = []
  const outcome = await streamCopilot('/api/x', {}, {
    onText: (delta) => texts.push(delta),
    onTool: (activity) => tools.push(activity.label),
  })
  assert.deepEqual(texts, ['Hel', 'lo'])
  assert.deepEqual(tools, ['Reading run r1'])
  assert.deepEqual(outcome, { ok: true, result: { type: 'result', reply: 'done' } })
})

test('an error event resolves as failure', async () => {
  sseFetch(['data: {"type":"error","message":"budget","code":"BUDGET_EXCEEDED"}\n\n'])
  const outcome = await streamCopilot('/api/x', {}, {})
  assert.deepEqual(outcome, { ok: false, error: 'budget', code: 'BUDGET_EXCEEDED' })
})

test('a JSON (non-stream) error response resolves as failure with status', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'Monthly token budget reached' }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
  const outcome = await streamCopilot('/api/x', {}, {})
  assert.equal(outcome.ok, false)
  if (!outcome.ok) { assert.equal(outcome.status, 429); assert.match(outcome.error, /budget/) }
})

test('a stream that ends without a result event is a connection loss', async () => {
  sseFetch(['data: {"type":"text","delta":"partial"}\n\n'])
  const outcome = await streamCopilot('/api/x', {}, {})
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(outcome.error, /Connection lost/)
})
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/server/__tests__/sse.test.ts src/lib/client/__tests__/copilot-stream.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `src/lib/server/sse.ts`**

```ts
/**
 * Server-sent-events response for the copilot chat routes. `data:`-only wire
 * format (no event: names) — the client switches on the JSON `type` field.
 * The handler's own throw becomes a terminal {type:'error'} event: once the
 * stream has started we can no longer change the HTTP status, so the error
 * must travel in-band.
 */
export function sseResponse(run: (emit: (event: object) => void) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      try {
        await run(emit)
      } catch (error) {
        emit({ type: 'error', message: error instanceof Error ? error.message : 'The assistant could not respond.' })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Disable proxy buffering so tokens reach the browser as they are written.
      'X-Accel-Buffering': 'no',
    },
  })
}
```

- [ ] **Step 5: Implement `src/lib/client/copilot-stream.ts`**

```ts
/**
 * Client half of the copilot SSE protocol: POST, then dispatch parsed events
 * to callbacks until the terminal result/error event. A JSON response (4xx
 * before the stream opened, or the legacy non-streaming path) is handled
 * transparently so callers have exactly one code path.
 */
export type CopilotStreamCallbacks = {
  onText?: (delta: string) => void
  onTool?: (activity: { name: string; label: string }) => void
}

export type CopilotStreamOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; code?: string; status?: number }

export async function streamCopilot(
  url: string,
  body: unknown,
  callbacks: CopilotStreamCallbacks,
): Promise<CopilotStreamOutcome> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, error: 'Connection lost — check your network and resend.' }
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (response.ok && data.success) return { ok: true, result: data }
    return {
      ok: false,
      error: typeof data.error === 'string' ? data.error : 'The assistant is unavailable right now.',
      ...(typeof data.code === 'string' ? { code: data.code } : {}),
      status: response.status,
    }
  }

  const reader = response.body?.getReader()
  if (!reader) return { ok: false, error: 'Connection lost — resend to try again.' }
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
      if (!frame.startsWith('data: ')) continue
      let event: Record<string, unknown>
      try {
        event = JSON.parse(frame.slice(6)) as Record<string, unknown>
      } catch {
        continue
      }
      if (event.type === 'text' && typeof event.delta === 'string') callbacks.onText?.(event.delta)
      else if (event.type === 'tool' && typeof event.label === 'string') {
        callbacks.onTool?.({ name: String(event.name ?? ''), label: event.label })
      } else if (event.type === 'result') return { ok: true, result: event }
      else if (event.type === 'error') {
        return {
          ok: false,
          error: typeof event.message === 'string' ? event.message : 'The assistant could not respond.',
          ...(typeof event.code === 'string' ? { code: event.code } : {}),
        }
      }
    }
  }
  return { ok: false, error: 'Connection lost — resend to try again.' }
}
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/server/__tests__/sse.test.ts src/lib/client/__tests__/copilot-stream.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/server/sse.ts src/lib/client/copilot-stream.ts src/lib/server/__tests__/sse.test.ts src/lib/client/__tests__/copilot-stream.test.ts
git commit -m "feat: SSE transport pair for copilot streaming"
```

---

### Task 4: Agents copilot read tools + terminal tool

**Files:**
- Modify: `src/features/agents/assistant-context.ts` (export a per-run detail loader; the private helpers `clip`/`summarizeRun` already exist ~lines 18–50)
- Create: `src/features/agents/copilot-tools.ts`
- Test: `src/features/agents/__tests__/copilot-tools.test.ts` (create)

**Interfaces:**
- Consumes: `CopilotTool` from Task 2; `agentReadScope` from `@/lib/server/visibility`; `loadFlowToolCatalog` from `@/lib/flows/tool-catalog`; `readAgentMetadata` from `@/lib/agents/metadata`; prisma models `AgentExecution` (fields: id, status, startedAt, completedAt, metadata, agentTaskId, organizationId, transcript[omit]) and `WorkflowStep` (id, executionId, node, status, input, output, error).
- Produces (consumed by Task 5):

```ts
// assistant-context.ts — new export
export async function loadRunDetail(
  agentTaskId: string,
  organizationId: string,
  runId: string,
): Promise<Record<string, unknown> | null>   // null = not found / not this agent's run

// copilot-tools.ts
export const PROPOSE_CONFIG_TOOL: ToolDefinition   // name: 'propose_config_change'
export function buildAgentCopilotTools(input: {
  agentId: string
  organizationId: string
  userId: string
}): CopilotTool[]   // [list_runs, get_run, get_step_output, get_tool_schema, list_workspace_agents]
```

- [ ] **Step 1: Export `loadRunDetail` from assistant-context.ts**

Inside `src/features/agents/assistant-context.ts`, the `detailFor` closure (~line 119) already builds the exact shape. Add a standalone export that loads ONE run by id, reusing the module's private `summarizeRun` and `clip`:

```ts
/** Full detail for one specific run — the copilot get_run tool. Returns null
 *  when the run doesn't exist or belongs to another agent/org (the caller
 *  reports "not found" to the model; it must not learn which). */
export async function loadRunDetail(
  agentTaskId: string,
  organizationId: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const execution = await prisma.agentExecution.findFirst({
    where: { id: runId, agentTaskId, organizationId },
    omit: { transcript: true },
  })
  if (!execution) return null
  const [steps, messages] = await Promise.all([
    prisma.workflowStep.findMany({ where: { executionId: execution.id }, orderBy: { createdAt: 'asc' } }),
    prisma.executionMessage.findMany({ where: { executionId: execution.id }, orderBy: { createdAt: 'asc' } }),
  ])
  return {
    ...summarizeRun(execution),
    toolCalls: steps.map((step) => ({
      tool: step.node,
      status: step.status,
      input: clip(step.input, 600) || null,
      output: clip(step.output, 800) || null,
      error: clip(step.error, 800) || null,
    })),
    conversation: messages.map((message) => ({ role: message.role, content: clip(message.content, 600) })),
  }
}
```

(Verify the exact `ExecutionRow` typing compiles against `summarizeRun` — it takes the same row shape `buildAssistantContext` fetches.)

- [ ] **Step 2: Write the failing tests**

Create `src/features/agents/__tests__/copilot-tools.test.ts` using the seeded-org pattern. The security test is the one that matters most:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

let prisma: typeof import('@/lib/prisma').prisma
let orgA: Awaited<ReturnType<typeof seedOrg>>
let orgB: Awaited<ReturnType<typeof seedOrg>>

async function seedOrg() {
  const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
  return seedTestOrg(prisma)
}

before(async () => {
  ;({ prisma } = await import('@/lib/prisma'))
  orgA = await seedOrg()
  orgB = await seedOrg()
})

after(async () => {
  await orgA.cleanup()
  await orgB.cleanup()
})

async function makeAgentWithRun(org: typeof orgA) {
  const agent = await prisma.agentTask.create({
    data: {
      description: 'test agent', objective: 'test', organizationId: org.auth.organizationId,
      userId: org.auth.dbUser.id, visibility: 'org_visible',
      metadata: { title: 'Test Agent' },
    },
  })
  const run = await prisma.agentExecution.create({
    data: {
      agentTaskId: agent.id, organizationId: org.auth.organizationId,
      status: 'failed', startedAt: new Date(),
      metadata: { error: 'Salesforce auth expired' },
    },
  })
  const step = await prisma.workflowStep.create({
    data: { executionId: run.id, node: 'salesforce_query', status: 'failed', input: { soql: 'SELECT…' }, error: { message: 'INVALID_SESSION_ID' } },
  })
  return { agent, run, step }
}

test('get_run returns detail for own run, null-equivalent error for another org', async () => {
  const { buildAgentCopilotTools } = await import('../copilot-tools')
  const a = await makeAgentWithRun(orgA)
  const b = await makeAgentWithRun(orgB)

  const tools = buildAgentCopilotTools({
    agentId: a.agent.id, organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id,
  })
  const getRun = tools.find((tool) => tool.definition.name === 'get_run')!

  const own = (await getRun.execute({ runId: a.run.id })) as Record<string, unknown>
  assert.equal(own.status, 'failed')
  assert.ok(Array.isArray(own.toolCalls))

  // SECURITY: org A's copilot must not read org B's run — same answer as nonexistent.
  const foreign = (await getRun.execute({ runId: b.run.id })) as Record<string, unknown>
  assert.deepEqual(foreign, { error: 'Run not found.' })
})

test('list_runs is capped at 20 and scoped to the agent', async () => {
  const { buildAgentCopilotTools } = await import('../copilot-tools')
  const a = await makeAgentWithRun(orgA)
  const tools = buildAgentCopilotTools({
    agentId: a.agent.id, organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id,
  })
  const listRuns = tools.find((tool) => tool.definition.name === 'list_runs')!
  const result = (await listRuns.execute({ limit: 500 })) as { runs: unknown[] }
  assert.ok(result.runs.length <= 20)
})

test('get_step_output refuses a step whose run belongs to another org', async () => {
  const { buildAgentCopilotTools } = await import('../copilot-tools')
  const a = await makeAgentWithRun(orgA)
  const b = await makeAgentWithRun(orgB)
  const tools = buildAgentCopilotTools({
    agentId: a.agent.id, organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id,
  })
  const getStep = tools.find((tool) => tool.definition.name === 'get_step_output')!
  const foreign = (await getStep.execute({ runId: b.run.id, stepId: b.step.id })) as Record<string, unknown>
  assert.deepEqual(foreign, { error: 'Step not found.' })
})

test('every tool has a label builder that mentions its subject', async () => {
  const { buildAgentCopilotTools } = await import('../copilot-tools')
  const tools = buildAgentCopilotTools({ agentId: 'a1', organizationId: 'o1', userId: 'u1' })
  assert.deepEqual(
    tools.map((tool) => tool.definition.name).sort(),
    ['get_run', 'get_step_output', 'get_tool_schema', 'list_runs', 'list_workspace_agents'],
  )
  const getRun = tools.find((tool) => tool.definition.name === 'get_run')!
  assert.match(getRun.label({ runId: 'run_abc12345' }), /run_abc1/)
})
```

(If `seedTestOrg` requires unique-per-call seeds, follow whatever the existing two-org tests in `src/app/api/__tests__/rbac-e2e.test.ts` do — copy their seeding idiom.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/agents/__tests__/copilot-tools.test.ts`
Expected: FAIL — `Cannot find module '../copilot-tools'`.

- [ ] **Step 4: Implement `src/features/agents/copilot-tools.ts`**

```ts
import { prisma } from '@/lib/prisma'
import type { ToolDefinition } from '@/lib/llm/model-runner'
import type { CopilotTool } from '@/lib/llm/copilot-loop'
import { agentReadScope } from '@/lib/server/visibility'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { loadRunDetail } from './assistant-context'

/**
 * Read-only lookups the agents copilot may make mid-turn. Every executor is
 * scoped by organizationId (and agentId where relevant); a miss and a
 * forbidden row return the SAME shape so the model cannot probe other orgs.
 */

const short = (id: unknown) => String(id ?? '').slice(0, 8)

function clipText(value: unknown, max: number): string {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text
}

export const PROPOSE_CONFIG_TOOL: ToolDefinition = {
  name: 'propose_config_change',
  description:
    'Propose a configuration change for this agent. Call this ONCE, at the end, only when the user asked for a change. Fill only the fields that should change; the user reviews and confirms in the interface — never claim the change was applied.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string', description: 'One sentence describing the change.' },
      title: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      instructions: { type: ['string', 'null'], description: 'Complete replacement instructions, not a diff.' },
      model: { type: ['string', 'null'] },
      integrations: { type: ['array', 'null'], items: { type: 'string' } },
      skills: { type: ['array', 'null'], items: { type: 'string' } },
      schedule: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['manual', 'hourly', 'daily', 'weekly', 'cron'] },
          time: { type: 'string', description: '24h HH:MM start time; empty string when not applicable.' },
          cron: { type: 'string', description: 'Cron expression; empty string unless type is "cron".' },
          timezone: { type: 'string', description: 'IANA timezone, e.g. UTC.' },
          isActive: { type: 'boolean' },
        },
        required: ['type', 'time', 'cron', 'timezone', 'isActive'],
      },
    },
    required: ['summary', 'title', 'description', 'instructions', 'model', 'integrations', 'skills', 'schedule'],
  },
}

export function buildAgentCopilotTools(input: {
  agentId: string
  organizationId: string
  userId: string
}): CopilotTool[] {
  const { agentId, organizationId, userId } = input
  return [
    {
      definition: {
        name: 'list_runs',
        description: "List this agent's recent runs (newest first). Filter by status ('completed' | 'failed' | 'running') and page with `before` (ISO timestamp).",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: ['string', 'null'] },
            limit: { type: ['number', 'null'], description: 'Max 20.' },
            before: { type: ['string', 'null'], description: 'ISO timestamp cursor.' },
          },
          required: ['status', 'limit', 'before'],
        },
      },
      label: () => 'Listing recent runs',
      execute: async (args) => {
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20)
        const runs = await prisma.agentExecution.findMany({
          where: {
            agentTaskId: agentId,
            organizationId,
            ...(typeof args.status === 'string' && args.status ? { status: args.status } : {}),
            ...(typeof args.before === 'string' && args.before ? { startedAt: { lt: new Date(args.before) } } : {}),
          },
          omit: { transcript: true },
          orderBy: { startedAt: 'desc' },
          take: limit,
        })
        return {
          runs: runs.map((run) => ({
            id: run.id,
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            completedAt: run.completedAt ? run.completedAt.toISOString() : null,
            error: clipText((run.metadata as Record<string, unknown> | null)?.error, 300) || null,
          })),
        }
      },
    },
    {
      definition: {
        name: 'get_run',
        description: 'Full detail for one run of this agent: every step with tool calls (inputs/outputs/errors) and the run conversation. Use after list_runs to inspect a specific run.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { runId: { type: 'string' } },
          required: ['runId'],
        },
      },
      label: (args) => `Reading run ${short(args.runId)}…`,
      execute: async (args) => {
        const detail = await loadRunDetail(agentId, organizationId, String(args.runId ?? ''))
        return detail ?? { error: 'Run not found.' }
      },
    },
    {
      definition: {
        name: 'get_step_output',
        description: "One step's full input/output/error at a larger clip than get_run provides. Use when the get_run excerpt was truncated at the interesting part.",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { runId: { type: 'string' }, stepId: { type: 'string' } },
          required: ['runId', 'stepId'],
        },
      },
      label: (args) => `Inspecting step ${short(args.stepId)} of run ${short(args.runId)}…`,
      execute: async (args) => {
        const step = await prisma.workflowStep.findFirst({
          where: {
            id: String(args.stepId ?? ''),
            executionId: String(args.runId ?? ''),
            execution: { agentTaskId: agentId, organizationId },
          },
        })
        if (!step) return { error: 'Step not found.' }
        return {
          tool: step.node,
          status: step.status,
          input: clipText(step.input, 4000) || null,
          output: clipText(step.output, 4000) || null,
          error: clipText(step.error, 4000) || null,
        }
      },
    },
    {
      definition: {
        name: 'get_tool_schema',
        description: "A connected tool's input/output JSON schema from the workspace tool catalog. Use to check whether a run's tool call arguments were malformed.",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { connectionId: { type: 'string' }, toolName: { type: 'string' } },
          required: ['connectionId', 'toolName'],
        },
      },
      label: (args) => `Checking the ${String(args.toolName ?? 'tool')} schema…`,
      execute: async (args) => {
        const catalog = await loadFlowToolCatalog(organizationId, {
          userId,
          connectionIds: [String(args.connectionId ?? '')],
        })
        const connection = catalog.find((entry) => entry.id === String(args.connectionId ?? ''))
        const tool = connection?.tools.find((entry) => entry.name === String(args.toolName ?? ''))
        if (!tool) return { error: 'Tool not found.' }
        return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? null, outputSchema: tool.outputSchema ?? null, risk: tool.risk ?? null }
      },
    },
    {
      definition: {
        name: 'list_workspace_agents',
        description: 'Other agents visible to this user in the workspace (id, title, schedule, integrations) — for comparing configuration with a sibling that works.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      },
      label: () => 'Listing workspace agents',
      execute: async () => {
        const agents = await prisma.agentTask.findMany({
          where: { organizationId, ...agentReadScope(userId) },
          orderBy: { updatedAt: 'desc' },
          take: 25,
        })
        return {
          agents: agents.map((agent) => {
            const metadata = readAgentMetadata(agent)
            return {
              id: agent.id,
              title: metadata.title || agent.description.slice(0, 80),
              status: agent.status,
              schedule: agent.schedule,
              integrations: metadata.integrations ?? [],
              model: metadata.model ?? null,
            }
          }),
        }
      },
    },
  ]
}
```

(Adjust `readAgentMetadata` field access to its actual return type — check `src/lib/agents/metadata.ts` exports before writing; if `metadata.title` etc. differ, map from what exists. Loading the catalog is already org-scoped by its first argument.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/agents/__tests__/copilot-tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/features/agents/copilot-tools.ts src/features/agents/assistant-context.ts src/features/agents/__tests__/copilot-tools.test.ts
git commit -m "feat(agents): copilot read tools + propose_config_change terminal tool"
```

---

### Task 5: Rewire the agents chat route (SSE + JSON fallback)

**Files:**
- Modify: `src/app/api/agents/[id]/chat/route.ts` (the `POST` handler ~lines 170–290; `SYSTEM_PROMPT` ~line 23; delete `RESPONSE_SCHEMA` ~line 31)
- Create: `src/app/api/__tests__/fake-llm-sse.ts` (shared test helper)
- Test: `src/app/api/__tests__/agent-copilot-loop-e2e.test.ts` (create)

**Interfaces:**
- Consumes: `runCopilotLoop`, `CopilotStreamEvent` (Task 2); `sseResponse` (Task 3); `buildAgentCopilotTools`, `PROPOSE_CONFIG_TOOL` (Task 4); `createModelRunner` (existing); existing route locals: `proposalSchema`, `normalizeProposal`, `serializeMessage`, `deriveTitle`, `buildAssistantContext`, `checkMonthlyTokenBudget`, `recordTokenUsage`, `saveAgentMemory`.
- Produces: streaming POST contract — SSE events ending in `{type:'result', success:true, sessionId, messages:[user, assistant]}`; JSON fallback identical to today's body. GET/PATCH unchanged. Also produces the `fake-llm-sse.ts` helper used again by Task 8:

```ts
// src/app/api/__tests__/fake-llm-sse.ts
export type FakeTurn = { text?: string; toolUse?: { id: string; name: string; input: Record<string, unknown> } }
export async function startFakeLlm(turns: FakeTurn[]): Promise<{ url: string; requests: number; close: () => Promise<void> }>
```

- [ ] **Step 1: Write the shared fake-provider helper**

Create `src/app/api/__tests__/fake-llm-sse.ts`. Each POST to the fake serves the next scripted turn as a full Anthropic SSE message (text block and/or one tool_use block):

```ts
import http from 'node:http'

export type FakeTurn = { text?: string; toolUse?: { id: string; name: string; input: Record<string, unknown> } }

function sseFor(turn: FakeTurn): string {
  const events: [string, unknown][] = [
    ['message_start', { type: 'message_start', message: { id: 'msg_f', type: 'message', role: 'assistant', model: 'qwen-fake', content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 0 } } }],
  ]
  let index = 0
  if (turn.text) {
    events.push(
      ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: turn.text } }],
      ['content_block_stop', { type: 'content_block_stop', index }],
    )
    index += 1
  }
  if (turn.toolUse) {
    events.push(
      ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: turn.toolUse.id, name: turn.toolUse.name, input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.toolUse.input) } }],
      ['content_block_stop', { type: 'content_block_stop', index }],
    )
  }
  events.push(
    ['message_delta', { type: 'message_delta', delta: { stop_reason: turn.toolUse ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }],
    ['message_stop', { type: 'message_stop' }],
  )
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

/** Boots a fake Anthropic-wire endpoint that replays `turns` in order (the
 *  last turn repeats). Point QWEN_BASE_URL at `url`. */
export async function startFakeLlm(turns: FakeTurn[]) {
  let requests = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      void raw
      const turn = turns[Math.min(requests, turns.length - 1)]
      requests += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sseFor(turn))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    get requests() { return requests },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
```

- [ ] **Step 2: Write the failing route e2e test**

Create `src/app/api/__tests__/agent-copilot-loop-e2e.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { startFakeLlm } from './fake-llm-sse'

let prisma: typeof import('@/lib/prisma').prisma
let seeded: Awaited<ReturnType<Awaited<typeof import('@/lib/server/__tests__/test-auth')>['seedTestOrg']>>
let fake: Awaited<ReturnType<typeof startFakeLlm>>
let agentId: string

before(async () => {
  ;({ prisma } = await import('@/lib/prisma'))
  const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
  seeded = await seedTestOrg(prisma)
  installTestAuth(seeded.auth)

  const agent = await prisma.agentTask.create({
    data: {
      description: 'pipeline auditor', objective: 'audit', organizationId: seeded.auth.organizationId,
      userId: seeded.auth.dbUser.id, metadata: { title: 'Pipeline Auditor' },
    },
  })
  agentId = agent.id
  await prisma.agentExecution.create({
    data: { agentTaskId: agentId, organizationId: seeded.auth.organizationId, status: 'failed', startedAt: new Date(), metadata: { error: 'auth expired' } },
  })

  // Turn 1: model reads runs. Turn 2: model answers in prose.
  fake = await startFakeLlm([
    { toolUse: { id: 'tu1', name: 'list_runs', input: { status: 'failed', limit: 5, before: null } } },
    { text: 'The last run failed because Salesforce auth expired.' },
  ])
  process.env.QWEN_API_KEY = 'fake'
  process.env.QWEN_BASE_URL = fake.url
  process.env.AGENT_MODEL = 'qwen-3.7'
  delete process.env.ANTHROPIC_API_KEY
})

after(async () => {
  delete process.env.QWEN_API_KEY
  delete process.env.QWEN_BASE_URL
  delete process.env.AGENT_MODEL
  await fake.close()
  await seeded.cleanup()
})

const post = (accept: string, body: unknown) =>
  new NextRequest(new URL(`http://test/api/agents/${agentId}/chat`), {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept },
  } as never)

function parseSse(bodyText: string): Array<Record<string, unknown>> {
  return bodyText.split('\n\n').filter(Boolean)
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>)
}

test('streaming POST emits tool activity then a result event, and persists the thread', async () => {
  const { POST } = await import('../agents/[id]/chat/route')
  const response = await POST(post('text/event-stream', { message: 'why did the last run fail?' }))
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const events = parseSse(await new Response(response.body).text())

  const types = events.map((event) => event.type)
  assert.ok(types.includes('tool'), `expected a tool event, got ${JSON.stringify(types)}`)
  assert.equal(types[types.length - 1], 'result')

  const result = events[events.length - 1] as { success: boolean; sessionId: string; messages: Array<{ role: string; content: string }> }
  assert.equal(result.success, true)
  assert.equal(result.messages.length, 2)
  assert.match(result.messages[1].content, /auth expired/i)

  // Thread persisted exactly as the non-streaming path would persist it.
  const rows = await prisma.agentChatMessage.findMany({ where: { agentTaskId: agentId, sessionId: result.sessionId } })
  assert.equal(rows.length, 2)
})

test('JSON fallback returns the legacy body shape', async () => {
  const { POST } = await import('../agents/[id]/chat/route')
  const response = await POST(post('application/json', { message: 'and again?' }))
  assert.equal(response.headers.get('content-type')?.includes('application/json'), true)
  const body = (await response.json()) as { success: boolean; sessionId: string; messages: unknown[] }
  assert.equal(body.success, true)
  assert.equal(body.messages.length, 2)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/agent-copilot-loop-e2e.test.ts`
Expected: FAIL — the route still calls `generateStructured`; the fake's tool_use turn produces an unparseable reply (or the streaming test finds `content-type: application/json`). Either failure is acceptable evidence.

- [ ] **Step 4: Rewire the POST handler**

In `src/app/api/agents/[id]/chat/route.ts`:

Replace the imports of `generateStructured` with:

```ts
import { createModelRunner, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { runCopilotLoop, type CopilotStreamEvent } from '@/lib/llm/copilot-loop'
import { sseResponse } from '@/lib/server/sse'
import { buildAgentCopilotTools, PROPOSE_CONFIG_TOOL } from '@/features/agents/copilot-tools'
```

Replace `SYSTEM_PROMPT` (keep every existing line, add the loop contract):

```ts
const SYSTEM_PROMPT = [
  "You are the Sublime assistant for a single agent. You answer questions about the agent's recent runs, help debug failures, and turn natural-language requests into configuration changes.",
  'Ground every statement in the provided context and your lookups. You have read-only tools: list_runs, get_run, get_step_output, get_tool_schema, list_workspace_agents. Use them whenever the provided context does not already contain the answer — never say the context is missing something you could look up. You have at most 6 lookups per turn; investigate the most diagnostic thing first.',
  'When the user asks to change the agent — its instructions/objective, schedule, skills, connected tools/integrations, model, name, or description — call propose_config_change ONCE with only the fields that should change and every other field null. The instructions field must contain the complete updated instructions text, not a diff. Never claim a change was applied; the user reviews and confirms it in the interface.',
  'When the message is not a change request, answer in plain text and do not call propose_config_change.',
  'When debugging, find the latest failed run: quote the relevant error and the tool calls around it.',
  'Write concise markdown in sentence case. No emoji.',
].join('\n')
```

Delete `RESPONSE_SCHEMA` (the proposal shape now lives on `PROPOSE_CONFIG_TOOL.inputSchema`). Keep `proposalSchema` and `normalizeProposal` exactly as they are — they validate the terminal call.

Restructure `POST` so the turn logic is a local function and both content negotiations share it:

```ts
export const POST = withAuthenticatedApi(async (request, auth) => {
  if (!process.env.ANTHROPIC_API_KEY && !qwenConfigured()) {
    throw new ApiError('No model provider is configured', 503, 'AI_UNAVAILABLE')
  }
  const agentId = agentIdFromRequest(request)
  const { message, sessionId: requestedSessionId } = z
    .object({ message: z.string().min(1).max(4000), sessionId: z.string().optional() })
    .parse(await request.json())
  const agent = await requireAgent(agentId, auth)

  const budget = await checkMonthlyTokenBudget(auth.organizationId)
  if (budget.over) throw new ApiError('Monthly token budget reached for this workspace.', 429, 'BUDGET_EXCEEDED')

  // ... session resolution, buildAssistantContext + history load: UNCHANGED from today ...

  const runTurn = async (emit: (event: CopilotStreamEvent) => void) => {
    const runner = createModelRunner(DEFAULT_SUMMARY_MODEL)
    const transcript = runner.start(JSON.stringify({ context, conversation, question: message }))
    let loop
    try {
      loop = await runCopilotLoop({
        runner,
        system: SYSTEM_PROMPT,
        transcript,
        readTools: buildAgentCopilotTools({ agentId, organizationId: auth.organizationId, userId: auth.dbUser.id }),
        terminalTool: PROPOSE_CONFIG_TOOL,
        emit,
      })
    } catch (error) {
      throw new ApiError('The assistant could not respond. Try again.', 502, 'ASSISTANT_FAILED', error)
    }

    const proposal = normalizeProposal(proposalSchema.catch(null).parse(loop.terminalCall ?? null))
    let reply = loop.text.trim()
    if (!reply) reply = proposal ? 'Here is the proposed configuration change.' : 'No answer returned.'

    // Real usage from the loop — the chars/4 estimate is gone.
    void recordTokenUsage(auth.organizationId, loop.usage.inputTokens + loop.usage.outputTokens).catch(() => undefined)

    // ... persist userMessage + assistantMessage, memory writeback, session bump: UNCHANGED from today ...

    return { success: true, sessionId: session.id, messages: [serializeMessage(userMessage), serializeMessage(assistantMessage)] }
  }

  if (request.headers.get('accept')?.includes('text/event-stream')) {
    return sseResponse(async (emit) => {
      const payload = await runTurn(emit as (event: CopilotStreamEvent) => void)
      emit({ type: 'result', ...payload })
    })
  }
  const payload = await runTurn(() => undefined)
  return payload
}, { requires: 'member', rateLimit: { feature: 'agent-chat', perUser: 30 } })
```

Two contract notes for the implementer:
- Inside the SSE branch, `ApiError` thrown by `runTurn` is caught by `sseResponse` and emitted as `{type:'error'}` — the HTTP status is already 200 at that point, which is correct for in-band stream errors. In the JSON branch it propagates to `withAuthenticatedApi` exactly as today.
- `createModelRunner(DEFAULT_SUMMARY_MODEL)` preserves today's provider routing + fallback chain; the spec's "one retry then error" failover comes from `AgentRunner.next`'s existing chain behavior.

- [ ] **Step 5: Run the new e2e + the existing chat tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/agent-copilot-loop-e2e.test.ts`
Expected: PASS (2 tests).

Run the full API suite to catch fallback regressions: `npm test 2>&1 | tail -20`
Expected: no new failures relative to the branch baseline.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/agents/[id]/chat/route.ts" src/app/api/__tests__/fake-llm-sse.ts src/app/api/__tests__/agent-copilot-loop-e2e.test.ts
git commit -m "feat(agents): copilot chat runs the read-tool loop and streams over SSE"
```

---

### Task 6: Agents client — stream into the assistant panel

**Files:**
- Modify: `src/app/(app)/g/[scope]/agents/assistant-panel.tsx` (the `send` function ~lines 239–290; the message list rendering ~lines 402–487; the local `Message` type near the top of the file)

**Interfaces:**
- Consumes: `streamCopilot` from `@/lib/client/copilot-stream` (Task 3). Server contract from Task 5.
- Produces: user-visible streaming. No new exports.

- [ ] **Step 1: Extend local message state**

Add to the panel's `Message` type: `activity?: string[]` (tool labels for the collapsed "investigated N things" affordance) and `streaming?: boolean`.

- [ ] **Step 2: Rewrite `send` around `streamCopilot`**

Replace the `fetch`/`response.json()` block (lines 254–268) with:

```ts
      const pendingId = `pending-${Date.now()}`
      setMessages((previous) => [
        ...previous,
        { id: pendingId, role: 'assistant', content: '', createdAt: new Date().toISOString(), streaming: true, activity: [] },
      ])
      const outcome = await streamCopilot(
        `/api/agents/${targetAgentId}/chat`,
        { message: content, ...(targetSessionId ? { sessionId: targetSessionId } : {}) },
        {
          onText: (delta) => {
            if (agentIdRef.current !== targetAgentId) return
            setMessages((previous) => previous.map((entry) =>
              entry.id === pendingId ? { ...entry, content: entry.content + delta } : entry))
          },
          onTool: (activity) => {
            if (agentIdRef.current !== targetAgentId) return
            setMessages((previous) => previous.map((entry) =>
              entry.id === pendingId ? { ...entry, activity: [...(entry.activity ?? []), activity.label] } : entry))
          },
        },
      )
      if (agentIdRef.current !== targetAgentId) return
      if (!outcome.ok) {
        toast.error(outcome.error)
        setMessages((previous) => previous.filter((entry) => entry.id !== localId && entry.id !== pendingId))
        setInput(content)
        return
      }
      // The result payload is authoritative: replace the streamed approximation
      // (covers provider failover, where partial deltas may not match the final text).
      const result = outcome.result as { sessionId: string; messages: Array<Record<string, unknown>> }
      setMessages((previous) => {
        // Carry the streamed activity labels onto the final assistant message
        // before dropping the placeholder bubble.
        const activity = previous.find((entry) => entry.id === pendingId)?.activity ?? []
        const finalMessages = result.messages.map((entry, index) =>
          index === result.messages.length - 1 ? { ...(entry as object), activity } : entry)
        return [...previous.filter((entry) => entry.id !== localId && entry.id !== pendingId), ...finalMessages] as typeof previous
      })
      setSessionId(result.sessionId)
```

(Preserve the existing post-success side effects that today's success path performs after updating messages — read the surrounding code and keep every one of them.)

- [ ] **Step 3: Render streaming state**

In the message list: when `message.streaming` and `message.content === ''` and no activity yet, show the existing "Thinking…" row. When `message.activity?.length`, render under the bubble:

- While `streaming`: the latest activity label as a muted line with the spinner (e.g. `Reading run 4f2a…`).
- After completion (`!streaming` and `activity.length > 0`): a `<details>` element — `<summary>Investigated {n} thing{s}</summary>` expanding to a `<ul>` of the labels.

Follow the existing bubble classNames in the file (`mr-8 rounded-lg border bg-muted p-3 text-sm`) so nothing looks foreign. Remove the old standalone `{sending && (<div…>Thinking…</div>)}` block (lines 480–484) — the pending bubble replaces it.

- [ ] **Step 4: Verify in the browser harness**

No unit test carries this (it's render wiring). Minimum bar before commit: `npm run typecheck && npx eslint "src/app/(app)/g/[scope]/agents/assistant-panel.tsx" && NEXT_PUBLIC_SUPABASE_URL="https://placeholder.supabase.co" NEXT_PUBLIC_SUPABASE_ANON_KEY="placeholder-anon-key" npx next build` all clean.

For a real visual pass (recommended, not required): temp public harness page mounting `AssistantPanel` with `globalThis.fetch` monkeypatched to replay a canned SSE body — the protocol is documented in the repo memory note `browser-verification-harness` (temp route under `src/app/(public)/<name>/page.tsx`, add the path to `PUBLIC_PATHS` in `src/lib/auth/public-paths.ts`, drive with the cached Playwright chromium, then delete the route, revert the allow-list line, and `rm -rf .next/types`).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/g/[scope]/agents/assistant-panel.tsx"
git commit -m "feat(agents): assistant panel streams replies and shows tool activity"
```

---

### Task 7: Flows copilot tools + route rewire

**Files:**
- Create: `src/lib/flows/copilot-tools.ts`
- Modify: `src/app/api/flows/copilot/chat/route.ts` (whole POST body; `OPS_CONTRACT` ~line 38; delete `OPS_JSON_SCHEMA` ~line 22)
- Test: `src/lib/flows/__tests__/copilot-tools.test.ts` (create)
- Test: `src/app/api/__tests__/flow-copilot-loop-e2e.test.ts` (create)

**Interfaces:**
- Consumes: `CopilotTool`, `runCopilotLoop` (Task 2); `sseResponse` (Task 3); `startFakeLlm` (Task 5); `flowReadScope` from `@/lib/server/visibility`; `loadFlowToolCatalog`; prisma `FlowRun` (id, flowId, status, startedAt, finishedAt, error, organizationId) and `FlowRunStep` (id, flowRunId, nodeId, status; check output/error field names with `sed -n '934,960p' prisma/schema.prisma` before writing).
- Produces:

```ts
// src/lib/flows/copilot-tools.ts
export const EDIT_FLOW_TOOL: ToolDefinition   // name: 'edit_flow', input {message, opsJson}
export function buildFlowCopilotTools(input: {
  organizationId: string
  userId: string
  currentFlowId: string | null
}): CopilotTool[]   // [list_flow_runs, get_flow_run, get_tool_schema, get_flow]
```

Route request schema gains `flowId: z.string().optional()` (the canvas may be unsaved; tools that need a flow id return `{error}` when absent). Streaming result event: `{type:'result', success:true, message, ops, needsAttention}`; JSON fallback identical to today.

- [ ] **Step 1: Write the failing tools test**

Create `src/lib/flows/__tests__/copilot-tools.test.ts` — same seeded-two-orgs skeleton as Task 4's test (import `seedTestOrg`/`installTestAuth`, create a `Flow` + `FlowRun` + `FlowRunStep` per org). Assert:

```ts
test('get_flow_run refuses another org\'s run', async () => {
  const { buildFlowCopilotTools } = await import('../copilot-tools')
  const tools = buildFlowCopilotTools({ organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id, currentFlowId: flowA.id })
  const getRun = tools.find((tool) => tool.definition.name === 'get_flow_run')!
  const foreign = (await getRun.execute({ runId: runB.id })) as Record<string, unknown>
  assert.deepEqual(foreign, { error: 'Run not found.' })
})

test('get_flow returns a visible flow graph and refuses a private foreign one', async () => {
  const { buildFlowCopilotTools } = await import('../copilot-tools')
  const tools = buildFlowCopilotTools({ organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id, currentFlowId: null })
  const getFlow = tools.find((tool) => tool.definition.name === 'get_flow')!
  const own = (await getFlow.execute({ flowId: flowA.id })) as Record<string, unknown>
  assert.ok(own.graph)
  const foreign = (await getFlow.execute({ flowId: flowB.id })) as Record<string, unknown>
  assert.deepEqual(foreign, { error: 'Flow not found.' })
})

test('list_flow_runs without a flowId and without currentFlowId returns a helpful error', async () => {
  const { buildFlowCopilotTools } = await import('../copilot-tools')
  const tools = buildFlowCopilotTools({ organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id, currentFlowId: null })
  const list = tools.find((tool) => tool.definition.name === 'list_flow_runs')!
  const result = (await list.execute({ flowId: null, status: null, limit: null })) as Record<string, unknown>
  assert.match(String(result.error), /flow/i)
})
```

- [ ] **Step 2: Run to verify failure, then implement `src/lib/flows/copilot-tools.ts`**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/copilot-tools.test.ts` → module not found.

Implement:

```ts
import { prisma } from '@/lib/prisma'
import type { ToolDefinition } from '@/lib/llm/model-runner'
import type { CopilotTool } from '@/lib/llm/copilot-loop'
import { flowReadScope } from '@/lib/server/visibility'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'

const short = (id: unknown) => String(id ?? '').slice(0, 8)

function clipText(value: unknown, max: number): string {
  if (value == null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text
}

export const EDIT_FLOW_TOOL: ToolDefinition = {
  name: 'edit_flow',
  description:
    'Apply edit operations to the current flow. Call this ONCE, at the end, when the user asked for a change. opsJson is a JSON string containing an ARRAY of edit-op objects (the op shapes are defined in your instructions); use "[]" with an explanatory message when you change nothing.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      message: { type: 'string', description: 'A short, friendly explanation of what you changed or what you need, mentioning node labels.' },
      opsJson: { type: 'string', description: 'A JSON string containing an ARRAY of edit-op objects. Use "[]" when making no changes.' },
    },
    required: ['message', 'opsJson'],
  },
}

export function buildFlowCopilotTools(input: {
  organizationId: string
  userId: string
  currentFlowId: string | null
}): CopilotTool[] {
  const { organizationId, userId, currentFlowId } = input
  const visibleFlow = (flowId: string) =>
    prisma.flow.findFirst({ where: { id: flowId, organizationId, ...flowReadScope(userId) }, select: { id: true } })

  return [
    {
      definition: {
        name: 'list_flow_runs',
        description: "Recent runs of a flow (newest first). Omit flowId for the flow being edited. Filter by status ('running' | 'succeeded' | 'failed' | 'waiting').",
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: {
            flowId: { type: ['string', 'null'] },
            status: { type: ['string', 'null'] },
            limit: { type: ['number', 'null'], description: 'Max 20.' },
          },
          required: ['flowId', 'status', 'limit'],
        },
      },
      label: (args) => (args.flowId ? `Listing runs of flow ${short(args.flowId)}…` : 'Listing runs of this flow'),
      execute: async (args) => {
        const flowId = typeof args.flowId === 'string' && args.flowId ? args.flowId : currentFlowId
        if (!flowId) return { error: 'This flow has not been saved yet, so it has no runs. Ask about a specific flowId from get_flow, or skip run inspection.' }
        if (!(await visibleFlow(flowId))) return { error: 'Flow not found.' }
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20)
        const runs = await prisma.flowRun.findMany({
          where: { flowId, organizationId, ...(typeof args.status === 'string' && args.status ? { status: args.status } : {}) },
          orderBy: { startedAt: 'desc' },
          take: limit,
          select: { id: true, status: true, startedAt: true, finishedAt: true, error: true },
        })
        return {
          runs: runs.map((run) => ({
            id: run.id, status: run.status,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
            error: run.error ? clipText(run.error, 300) : null,
          })),
        }
      },
    },
    {
      definition: {
        name: 'get_flow_run',
        description: 'Per-node step results for one run: status, input/output excerpts, error. Use after list_flow_runs to see where a run went wrong.',
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: { runId: { type: 'string' } },
          required: ['runId'],
        },
      },
      label: (args) => `Reading flow run ${short(args.runId)}…`,
      execute: async (args) => {
        const run = await prisma.flowRun.findFirst({
          where: { id: String(args.runId ?? ''), organizationId, flow: { ...flowReadScope(userId) } },
          include: { steps: { orderBy: { createdAt: 'asc' } } },
        })
        if (!run) return { error: 'Run not found.' }
        return {
          id: run.id, status: run.status, error: run.error ?? null,
          steps: run.steps.map((step) => ({
            nodeId: step.nodeId, status: step.status,
            input: clipText(step.input, 800) || null,
            output: clipText(step.output, 800) || null,
            error: clipText(step.error, 800) || null,
          })),
        }
      },
    },
    {
      definition: {
        name: 'get_tool_schema',
        description: "A connected tool's input/output JSON schema — check exact argument names/types before wiring a tool node.",
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: { connectionId: { type: 'string' }, toolName: { type: 'string' } },
          required: ['connectionId', 'toolName'],
        },
      },
      label: (args) => `Checking the ${String(args.toolName ?? 'tool')} schema…`,
      execute: async (args) => {
        const catalog = await loadFlowToolCatalog(organizationId, { userId, connectionIds: [String(args.connectionId ?? '')] })
        const connection = catalog.find((entry) => entry.id === String(args.connectionId ?? ''))
        const tool = connection?.tools.find((entry) => entry.name === String(args.toolName ?? ''))
        if (!tool) return { error: 'Tool not found.' }
        return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? null, outputSchema: tool.outputSchema ?? null, risk: tool.risk ?? null }
      },
    },
    {
      definition: {
        name: 'get_flow',
        description: "Another visible flow's graph — to copy a working pattern or wire a subflow node.",
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: { flowId: { type: 'string' } },
          required: ['flowId'],
        },
      },
      label: (args) => `Reading flow ${short(args.flowId)}…`,
      execute: async (args) => {
        const flow = await prisma.flow.findFirst({
          where: { id: String(args.flowId ?? ''), organizationId, ...flowReadScope(userId) },
          select: { id: true, name: true, description: true, graph: true, trigger: true, status: true },
        })
        if (!flow) return { error: 'Flow not found.' }
        return flow
      },
    },
  ]
}
```

Implementation note: `FlowRunStep` field names (`input`, `output`, `error`) must be verified against `prisma/schema.prisma` lines 934–960 before writing; adjust the step mapping if the model stores them differently.

Run the tools test again → PASS. Commit:

```bash
git add src/lib/flows/copilot-tools.ts src/lib/flows/__tests__/copilot-tools.test.ts
git commit -m "feat(flows): copilot read tools + edit_flow terminal tool"
```

- [ ] **Step 3: Write the failing route e2e**

Create `src/app/api/__tests__/flow-copilot-loop-e2e.test.ts` reusing `startFakeLlm`. Script: turn 1 calls `get_flow_run`? No — simplest deterministic script: turn 1 calls `edit_flow` directly with an `update` op against a seeded graph:

```ts
// setup mirrors Task 5's test: seedTestOrg + installTestAuth + fake LLM env.
// Seed nothing flow-specific — the chat route takes the graph in the request body.
const GRAPH = {
  nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Manual', trigger: { type: 'manual' } } },
    { id: 'step1', type: 'agent', position: { x: 0, y: 120 }, data: { label: 'Draft', agentId: 'missing' } },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'step1' }],
}

before(async () => {
  // ...seed + auth as in Task 5...
  fake = await startFakeLlm([
    { text: 'Renaming the step.', toolUse: { id: 'tu1', name: 'edit_flow', input: { message: 'Renamed the draft step.', opsJson: JSON.stringify([{ op: 'update', id: 'step1', data: { label: 'Draft email' } }]) } } },
  ])
  // ...env vars as in Task 5...
})

test('streaming POST ends in a result event carrying sanitized ops', async () => {
  const { POST } = await import('../flows/copilot/chat/route')
  const request = new NextRequest(new URL('http://test/api/flows/copilot/chat'), {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'rename step1 to Draft email' }], graph: GRAPH }),
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
  } as never)
  const response = await POST(request)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const events = parseSse(await new Response(response.body).text())   // same parseSse helper as Task 5's test
  const result = events[events.length - 1] as { success: boolean; message: string; ops: Array<{ op: string }> }
  assert.equal(result.success, true)
  assert.equal(result.ops.length, 1)
  assert.equal(result.ops[0].op, 'update')
})

test('JSON fallback matches the legacy contract', async () => {
  const { POST } = await import('../flows/copilot/chat/route')
  const request = new NextRequest(new URL('http://test/api/flows/copilot/chat'), {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'rename step1' }], graph: GRAPH }),
    headers: { 'content-type': 'application/json' },
  } as never)
  const response = await POST(request)
  const body = (await response.json()) as { success: boolean; message: string; ops: unknown[]; needsAttention: unknown[] }
  assert.equal(body.success, true)
  assert.ok(Array.isArray(body.ops))
  assert.ok(Array.isArray(body.needsAttention))
})
```

- [ ] **Step 4: Rewire the flows route**

In `src/app/api/flows/copilot/chat/route.ts`:

- Delete `OPS_JSON_SCHEMA`. Keep `OPS_CONTRACT` but replace its second line (the reply-shape sentence) with: `'You are editing an existing flow conversationally. The graph shape rules above govern node/edge CONTENT (including the graph inside a replace op). When you decide on changes, call the edit_flow tool ONCE with {message, opsJson}; opsJson is a JSON string containing an ARRAY of edit operations (use "[]" when you change nothing).'` and append a final line: `'You also have read-only lookup tools (list_flow_runs, get_flow_run, get_tool_schema, get_flow) — at most 6 lookups per turn. Use them to check run failures and tool schemas instead of guessing.'`
- Request schema: add `flowId: z.string().optional()`.
- Replace the `generateStructured` call block with the loop + shared `runTurn` pattern from Task 5, adapted:

```ts
  const runTurn = async (emit: (event: CopilotStreamEvent) => void) => {
    const runner = createModelRunner()   // DEFAULT_AGENT_MODEL routing, as generateStructured effectively used
    const system = [graphRules, '', OPS_CONTRACT, '', contextBlock].join('\n')
    const transcript = runner.start([
      `Current flow graph JSON:\n${JSON.stringify(graph)}`,
      '',
      `Conversation so far:\n${transcriptText}`,
      '',
      'Respond to the latest user message.',
    ].join('\n'))

    const loop = await runCopilotLoop({
      runner, system, transcript,
      readTools: buildFlowCopilotTools({ organizationId: auth.organizationId, userId: auth.dbUser.id, currentFlowId: flowId ?? null }),
      terminalTool: EDIT_FLOW_TOOL,
      emit,
    })
    void recordTokenUsage(auth.organizationId, loop.usage.inputTokens + loop.usage.outputTokens).catch(() => undefined)

    // Terminal call → same sanitize/apply/validate pipeline as today.
    const terminal = loop.terminalCall as { message?: string; opsJson?: string } | null
    const reply = terminal
      ? parseCopilotChatReply(JSON.stringify({ message: terminal.message ?? '', opsJson: terminal.opsJson ?? '[]' }))
      : { message: loop.text.trim(), candidates: [], opsUnreadable: false }
    // ... from here the existing code runs UNCHANGED: sanitizeCopilotOps,
    // applyCopilotOps, baseMessage fallbacks, discardNotice, skipped-suffix,
    // validateFlowGraph, needsAttention ...
    return { success: true, message, ops, needsAttention }
  }

  if (request.headers.get('accept')?.includes('text/event-stream')) {
    return sseResponse(async (emit) => {
      const payload = await runTurn(emit as (event: CopilotStreamEvent) => void)
      emit({ type: 'result', ...payload })
    })
  }
  try {
    return await runTurn(() => undefined)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not apply that change.' }
  }
```

(`transcriptText` is today's `messages.map(...).join('\n\n')` — rename of the existing `transcript` string variable to free the name for the IR transcript. The JSON-fallback catch preserves today's `{success:false,error}` contract instead of a thrown 5xx.)

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/flow-copilot-loop-e2e.test.ts` → PASS.
Run: `npm test 2>&1 | tail -20` → no new failures. `npm run typecheck` → clean.

```bash
git add src/app/api/flows/copilot/chat/route.ts src/app/api/__tests__/flow-copilot-loop-e2e.test.ts
git commit -m "feat(flows): copilot chat runs the read-tool loop and streams over SSE"
```

---

### Task 8: Flows client — stream into the copilot panel

**Files:**
- Modify: `src/components/flows/copilot-panel.tsx` (`send` callback ~lines 101–148; message rendering; local message type)
- Modify: the panel's caller if it has the flow id available — check `grep -n "CopilotPanel" src/app/\(app\)/g/\[scope\]/flows/\[id\]/page.tsx` and pass `flowId` through as a prop so the route's `list_flow_runs` default works.

**Interfaces:**
- Consumes: `streamCopilot` (Task 3); Task 7's route contract (`{messages, graph, flowId?}` in, `result` event out).
- Produces: user-visible streaming; `flowId?: string` prop on `CopilotPanel`.

- [ ] **Step 1: Add `flowId` prop and thread it into the request body**

`CopilotPanel` gains `flowId?: string`; the flow editor page passes the current flow's id. `send` includes it: `body: { messages: history, graph: graphRef.current, flowId }`.

- [ ] **Step 2: Rewrite `send` around `streamCopilot`**

Replace the fetch block (lines 111–117) mirroring Task 6's shape: push a `{ role: 'assistant', content: '', streaming: true, activity: [] }` placeholder, accumulate `onText` deltas into it, append `onTool` labels to `activity`, and on `outcome.ok` run the EXISTING success block (candidateOps/apply/needsAttention logic, lines 118–141) against `outcome.result` instead of `data`, replacing the placeholder's `content` with the final `assistantContent`. On `!outcome.ok`, replace the placeholder with the existing error-bubble shape (`{ role: 'assistant', content: outcome.error, error: true }`) and restore the user's text with `setInput(content)` so a dropped connection is a one-keystroke resend.

- [ ] **Step 3: Render activity**

Same pattern as Task 6: latest label + spinner while streaming; collapsed `<details>Investigated {n} things</details>` after completion. Match the panel's existing bubble styling.

- [ ] **Step 4: Verify and commit**

`npm run typecheck && npx eslint src/components/flows/copilot-panel.tsx "src/app/(app)/g/[scope]/flows/[id]/page.tsx" && npm run build` → clean.

```bash
git add src/components/flows/copilot-panel.tsx "src/app/(app)/g/[scope]/flows/[id]/page.tsx"
git commit -m "feat(flows): copilot panel streams replies and shows tool activity"
```

---

### Task 9: Full verification sweep

**Files:** none created; this is the gate.

- [ ] **Step 1: Full test suite**

Run: `npm test 2>&1 | tail -25`
Expected: all green (or only failures already present on the branch baseline — record any).

- [ ] **Step 2: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && NEXT_PUBLIC_SUPABASE_URL="https://placeholder.supabase.co" NEXT_PUBLIC_SUPABASE_ANON_KEY="placeholder-anon-key" npx next build`
Expected: all clean.

- [ ] **Step 3: Grep for dead code**

Run: `grep -rn "generateStructured" src/app/api/agents src/app/api/flows/copilot/chat` — expected: no hits in these two routes (other callers elsewhere are untouched). Run: `grep -rn "chars/4\|length) / 4" src/app/api/agents src/app/api/flows/copilot/chat` — expected: no hits.

- [ ] **Step 4: Commit anything the sweep shook loose, then hand off**

```bash
git status --short   # expect clean
```

Use the superpowers:finishing-a-development-branch skill to decide integration.
