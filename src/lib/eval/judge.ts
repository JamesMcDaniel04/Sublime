/**
 * LLM-as-judge grading for eval fixtures.
 *
 * Deterministic asserts (checkTrajectory) catch structural regressions — which
 * tools ran, what the final text contains. The judge catches QUALITY
 * regressions the model produced: did the agent actually satisfy the rubric?
 * It runs against whatever provider key is configured (via generateStructured,
 * which already handles provider selection + fallback) and is skipped in CI
 * when no key is present.
 */
import { generateStructured } from '@/lib/llm/model-runner'
import type { JudgeResult, Trajectory } from './types'

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pass: { type: 'boolean', description: 'Whether the run satisfies the rubric.' },
    score: { type: 'number', description: 'Quality from 0 (fails) to 1 (excellent).' },
    reasoning: { type: 'string', description: 'One or two sentences justifying the verdict.' },
  },
  required: ['pass', 'score', 'reasoning'],
} as const

/** Compact, judge-readable rendering of a trajectory. */
function renderTrajectory(trajectory: Trajectory): string {
  const lines: string[] = []
  trajectory.turns.forEach((turn, i) => {
    if (turn.text) lines.push(`Turn ${i + 1} — agent: ${turn.text}`)
    for (const call of turn.toolCalls) lines.push(`Turn ${i + 1} — tool call: ${call.name}(${JSON.stringify(call.input)})`)
    for (const r of turn.results) lines.push(`Turn ${i + 1} — tool result${r.isError ? ' (ERROR)' : ''}: ${r.content.slice(0, 500)}`)
  })
  lines.push(`Final answer: ${trajectory.finalText || '(none)'}`)
  return lines.join('\n')
}

export async function judgeTrajectory(rubric: string, trajectory: Trajectory): Promise<JudgeResult> {
  const raw = await generateStructured({
    schemaName: 'eval_judgment',
    schema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    system:
      'You are a strict evaluator of AI agent runs. Given a grading rubric and a transcript of what the agent did (its reasoning, tool calls, tool results, and final answer), judge whether the run satisfies the rubric. Be rigorous: only pass a run that genuinely meets the criteria.',
    user: `RUBRIC:\n${rubric}\n\nTRANSCRIPT:\n${renderTrajectory(trajectory)}`,
  })
  const parsed = JSON.parse(raw) as Partial<JudgeResult>
  return {
    pass: Boolean(parsed.pass),
    score: typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  }
}
