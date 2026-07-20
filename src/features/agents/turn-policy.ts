/**
 * Pure per-turn policy decisions for the agent run loop (execute-agent.ts).
 * Extracted so the stop_reason → outcome mapping — the part that fixes a real
 * bug (a refusal or truncated reply silently treated as a clean finish) — is
 * unit-testable without the surrounding Prisma/queue machinery.
 */
import type { Effort, StopReason } from '@/lib/llm/model-runner'

export type TurnCapReason = 'model_refusal' | 'model_incomplete'

export type TurnStopOutcome =
  | { capped: null }
  | { capped: TurnCapReason; finalText: string }

/**
 * Only `end_turn` (done) and `tool_use` (keep working) are turns the run loop
 * should treat as a normal step. Everything else is a stop the model didn't
 * choose as a clean answer — a policy decline, or a reply cut off by the
 * output cap or a paused server-tool turn we don't resume — and must halt the
 * run with an explicit reason instead of falling through to "no tool calls ⇒
 * done".
 */
export function turnStopOutcome(turn: { stopReason: StopReason; text: string }): TurnStopOutcome {
  if (turn.stopReason === 'refusal') {
    return { capped: 'model_refusal', finalText: turn.text || 'The model declined to continue this run for safety or policy reasons.' }
  }
  if (turn.stopReason === 'max_tokens' || turn.stopReason === 'pause_turn') {
    return {
      capped: 'model_incomplete',
      finalText: turn.text || `Run stopped: the model's response was incomplete (${turn.stopReason}).`,
    }
  }
  return { capped: null }
}

/**
 * The first turn of a run (or of a resumed segment, after a user answers an
 * ask_user/approval pause) is where the agent orients and plans; later turns
 * are routine tool execution. Spend effort accordingly — the model-runner
 * gates this on model support, so it's a no-op for Haiku/Qwen.
 */
export function turnEffortFor(turn: number, startTurn: number): Effort {
  return turn === startTurn ? 'high' : 'medium'
}
