/**
 * The models a user can pick for an agent. Shared by the agent config form
 * and the template detail page so the two pickers never drift.
 *
 * An id must satisfy the runtime's provider routing (model-runner.ts): a
 * `claude*` id routes to Anthropic, anything else to the OpenAI-compatible
 * slot (Qwen). Claude first — platform default / most capable.
 */
export type ModelProvider = 'anthropic' | 'qwen'

export const MODEL_CATALOG: ReadonlyArray<{ id: string; label: string; provider: ModelProvider }> = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic' },
  { id: 'qwen-3.7', label: 'Qwen 3.7', provider: 'qwen' },
]

export function modelLabel(id: string): string {
  return MODEL_CATALOG.find((model) => model.id === id)?.label ?? id
}
