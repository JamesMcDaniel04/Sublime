/**
 * Deterministic portrait parts for an agent's avatar.
 *
 * The roster presents agents as people, so a face has to be stable forever:
 * the same agent must render identically on every device and every deploy,
 * with no stored image and no backfill for the agents that already exist.
 * That means deriving parts from a seed string rather than persisting them.
 *
 * Pure and dependency-free so it runs identically on the server (OG images,
 * emails) and in the browser, and unit-tests without a DOM.
 */

/** How many options each layer of the portrait has. */
export const AVATAR_PART_COUNTS = {
  background: 6,
  skin: 8,
  hair: 10,
  hairColor: 6,
  brows: 3,
  eyes: 5,
  mouth: 5,
  attire: 6,
  attireColor: 8,
} as const

// -readonly: the mapped type is homomorphic over an `as const` object, so it
// would otherwise inherit readonly on every key and reject the builder below.
export type AvatarParts = { -readonly [K in keyof typeof AVATAR_PART_COUNTS]: number }

/**
 * FNV-1a over the WHOLE string. Agent ids are cuids — a leading 'c' plus a
 * base36 timestamp — so ids minted in the same session share roughly ten
 * leading characters. Any hash that samples the front of the string gives a
 * whole workspace one face.
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * mulberry32: each part draws its own decorrelated value. Slicing bit ranges
 * out of a single hash instead would correlate neighbouring layers (every
 * dark-haired agent also dark-skinned), which reads as a bug even though each
 * layer alone looks uniform.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Resolve a seed into one index per portrait layer. Never throws. */
export function avatarPartsFor(seed: string): AvatarParts {
  const next = mulberry32(fnv1a(seed))
  const parts = {} as AvatarParts
  for (const key of Object.keys(AVATAR_PART_COUNTS) as (keyof typeof AVATAR_PART_COUNTS)[]) {
    parts[key] = Math.floor(next() * AVATAR_PART_COUNTS[key])
  }
  return parts
}

/**
 * The seed to draw an agent's face from: an explicitly stored seed (set when
 * someone re-rolls the look) if there is one, else the agent id — which is why
 * every pre-existing agent already has a stable face with no migration.
 */
export function avatarSeedFor(agent: { id: string; avatarSeed?: string | null }): string {
  const stored = agent.avatarSeed?.trim()
  return stored ? stored : agent.id
}
