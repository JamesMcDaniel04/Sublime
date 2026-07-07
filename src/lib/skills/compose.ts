import skills from './den-skills.json'

export type SkillSummary = {
  id: string
  name: string
  description: string
  category: string
  audience: string[]
  tags: string[]
  integrations: string[]
}

export type Skill = SkillSummary & {
  instructions: string
}

/** Returns all skills without the heavy `instructions` field — for UI listing. */
export function listSkills(): SkillSummary[] {
  return (skills as Skill[]).map(({ id, name, description, category, audience, tags, integrations }) => ({
    id,
    name,
    description,
    category,
    audience,
    tags,
    integrations,
  }))
}

/** Returns the full skill (with instructions) or undefined if not found. */
export function getSkill(id: string): Skill | undefined {
  return (skills as Skill[]).find((s) => s.id === id)
}

/**
 * Composes an agent's effective prompt by appending each attached skill's
 * instructions block to the base instructions.
 */
export function composeInstructions(baseInstructions: string, skillIds: string[]): string {
  if (!skillIds || skillIds.length === 0) return baseInstructions

  const blocks: string[] = [baseInstructions]
  for (const id of skillIds) {
    const skill = getSkill(id)
    if (skill) {
      blocks.push(`\n\n## Attached skill: ${skill.name}\n${skill.instructions}`)
    }
  }
  return blocks.join('')
}
