import type { Effort, ModelRunner, ToolDefinition, ToolResult } from '@/lib/llm/model-runner'

/**
 * Bounded investigate-then-answer runner shared by the copilot chat routes.
 * See docs/superpowers/specs/2026-08-03-copilot-tool-loop-streaming-design.md.
 *
 * Structural guarantees (never prompt-enforced):
 * - At most maxReadCalls read-tool executions per turn; once spent, the model
 *   is only offered the terminal tool, so an extra lookup is impossible.
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
    // gets a matching tool_result — the Messages API requires the pairing.
    const results: ToolResult[] = []
    for (const call of turn.toolCalls) {
      const tool = toolsByName.get(call.name)
      if (!tool || hops >= maxReadCalls) {
        results.push({
          toolCallId: call.id,
          content: JSON.stringify({
            error: tool ? 'Lookup budget exhausted — answer with what you have.' : `Unknown tool: ${call.name}`,
          }),
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
