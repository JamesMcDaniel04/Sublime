import skills from './sublime-skills.json'

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

/** A community-authored skill resolved from the database at run time. */
export type ExtraSkill = { id: string; name: string; instructions: string }

/**
 * Composes an agent's effective prompt by appending each attached skill's
 * instructions block to the base instructions. Built-in skills resolve from
 * the bundled JSON; community skills are passed in via `extraSkills` (the
 * caller looks them up, keeping this module dependency-light and sync).
 */
export function composeInstructions(baseInstructions: string, skillIds: string[], extraSkills: ExtraSkill[] = []): string {
  if (!skillIds || skillIds.length === 0) return baseInstructions

  const extraById = new Map(extraSkills.map((skill) => [skill.id, skill]))
  const blocks: string[] = [baseInstructions]
  for (const id of skillIds) {
    const skill = getSkill(id) ?? extraById.get(id)
    if (skill) {
      blocks.push(`\n\n## Attached skill: ${skill.name}\n${skill.instructions}`)
    }
  }
  return blocks.join('')
}
