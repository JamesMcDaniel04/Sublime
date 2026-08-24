/**
 * Seed derivation for an agent's portrait.
 *
 * The roster presents agents as people, so a face has to be stable forever:
 * the same agent must render identically on every device and every deploy,
 * with no stored image and no backfill for the agents that already exist.
 * That means resolving a SEED and letting the portrait be derived from it
 * (lib/agents/avatar-portraits.ts) rather than persisting a face.
 *
 * The generated-SVG part indices that used to live here were removed when
 * authored 3D portraits replaced the drawn faces — nothing read them once the
 * component stopped drawing.
 *
 * Pure and dependency-free so it runs identically on the server (OG images,
 * emails) and in the browser, and unit-tests without a DOM.
 */

/**
 * The seed to draw an agent's face from: an explicitly stored seed (set when
 * someone re-rolls the look) if there is one, else the agent id — which is why
 * every pre-existing agent already has a stable face with no migration.
 */
export function avatarSeedFor(agent: { id: string; avatarSeed?: string | null }): string {
  const stored = agent.avatarSeed?.trim()
  return stored ? stored : agent.id
}

/**
 * A fresh seed for the "try another look" control.
 *
 * Base36 of a random draw plus a counter: two clicks in the same millisecond
 * must not return the same string, or the re-roll silently does nothing.
 */
let rerollCounter = 0
export function randomAvatarSeed(): string {
  rerollCounter += 1
  return `r${Math.random().toString(36).slice(2, 10)}${rerollCounter.toString(36)}`
}
