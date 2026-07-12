export type RouterBranchSpec = { id: string; label?: string; description?: string }

/** JSON schema constraining the model reply to one known branch id (or default). */
export function routerBranchSchema(branches: RouterBranchSpec[]): Record<string, unknown> {
  const ids = branches.map((b) => b.id.trim()).filter(Boolean)
  return {
    type: 'object',
    properties: { branch: { type: 'string', enum: [...ids, 'default'] } },
    required: ['branch'],
    additionalProperties: false,
  }
}

/** The routing prompt: each branch's id + human hint, and the input to classify. */
export function buildRouterPrompt(
  branches: RouterBranchSpec[],
  instructions: string | undefined,
  input: string,
): { system: string; user: string } {
  const lines = branches
    .filter((b) => b.id.trim())
    .map((b) => `- "${b.id.trim()}"${b.label?.trim() ? ` (${b.label.trim()})` : ''}${b.description?.trim() ? `: ${b.description.trim()}` : ''}`)
  const system = [
    'You are a router. Choose the single best branch for the input from the list below.',
    'Reply with ONLY a JSON object {"branch": "<id>"} using one of these exact ids (or "default" if none fits):',
    ...lines,
    instructions?.trim() ? `\nAdditional guidance: ${instructions.trim()}` : '',
  ].filter(Boolean).join('\n')
  return { system, user: input }
}

function extractJson(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const braces = trimmed.match(/\{[\s\S]*\}/)
  if (braces) candidates.push(braces[0])
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* next */ }
  }
  return undefined
}

/** Validate the model's pick against the known branch ids (or 'default'). */
export function parseRouterChoice(raw: string, branches: RouterBranchSpec[]): { branch: string } | { error: string } {
  const record = extractJson(raw)
  const choice = record && typeof record.branch === 'string' ? record.branch.trim() : ''
  if (!choice) return { error: 'The router did not return a branch choice.' }
  const known = new Set([...branches.map((b) => b.id.trim()).filter(Boolean), 'default'])
  if (!known.has(choice)) return { error: `The router chose an unknown branch "${choice}".` }
  return { branch: choice }
}
