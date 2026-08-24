/**
 * The roster's portrait set.
 *
 * Replaces the generated SVG faces with 24 authored 3D portraits. The reason
 * to switch is quality, not mechanism — the property that mattered about the
 * generated faces is preserved exactly: a portrait is DERIVED from a seed, so
 * the same agent renders identically on every device and every deploy, with
 * nothing stored on the row and no backfill for agents that already exist.
 *
 * Each portrait carries its own tint, taken from the character's dominant
 * garment colour, so the tile behind a portrait always agrees with it instead
 * of picking a backdrop at random.
 *
 * Pure and dependency-free so it runs identically on the server and in the
 * browser, and unit-tests without a DOM.
 */

export type Portrait = {
  /** Public path to the image. */
  src: string
  /** Tile tint, light theme. */
  tint: string
  /** Tile tint, dark theme — same hue, dropped to sit under dark surfaces. */
  tintDark: string
}

/**
 * Ordered, append-only. Reordering or removing an entry re-faces every
 * existing agent, because the index is what the seed resolves to — treat this
 * list the way you would treat a database enum.
 */
export const PORTRAITS: readonly Portrait[] = [
  { src: '/avatars/01-cobalt-operator.webp', tint: '#E4E9FA', tintDark: '#20263D' },
  { src: '/avatars/02-amber-architect.webp', tint: '#FAEEDD', tintDark: '#33291A' },
  { src: '/avatars/03-mint-strategist.webp', tint: '#DFF2EA', tintDark: '#172E27' },
  { src: '/avatars/04-magenta-producer.webp', tint: '#FADFEE', tintDark: '#331A2A' },
  { src: '/avatars/05-teal-researcher.webp', tint: '#DBF0F2', tintDark: '#152E31' },
  { src: '/avatars/06-indigo-builder.webp', tint: '#E2E3F8', tintDark: '#1F203C' },
  { src: '/avatars/07-coral-planner.webp', tint: '#FBE3DC', tintDark: '#341F19' },
  { src: '/avatars/08-lime-analyst.webp', tint: '#EDF5D8', tintDark: '#252E15' },
  { src: '/avatars/09-violet-designer.webp', tint: '#EBE1F7', tintDark: '#271C3A' },
  { src: '/avatars/10-sky-mentor.webp', tint: '#DEEDFA', tintDark: '#182839' },
  { src: '/avatars/11-tangerine-lead.webp', tint: '#FBE7D6', tintDark: '#342316' },
  { src: '/avatars/12-rose-writer.webp', tint: '#FBE0E6', tintDark: '#341B22' },
  { src: '/avatars/13-aqua-engineer.webp', tint: '#DBF1F5', tintDark: '#152F34' },
  { src: '/avatars/14-chartreuse-growth.webp', tint: '#F0F5D5', tintDark: '#282E13' },
  { src: '/avatars/15-ruby-operator.webp', tint: '#FADEE0', tintDark: '#341A1D' },
  { src: '/avatars/16-navy-director.webp', tint: '#DEE3F1', tintDark: '#171D33' },
  { src: '/avatars/17-sunshine-success.webp', tint: '#FAF0D5', tintDark: '#332C13' },
  { src: '/avatars/18-plum-scientist.webp', tint: '#EEDFF3', tintDark: '#2C1B33' },
  { src: '/avatars/19-emerald-advisor.webp', tint: '#DCF0E3', tintDark: '#152F20' },
  { src: '/avatars/20-periwinkle-pm.webp', tint: '#E3E6FA', tintDark: '#1E213C' },
  { src: '/avatars/21-pink-community.webp', tint: '#FBE1EC', tintDark: '#341C28' },
  { src: '/avatars/22-bronze-security.webp', tint: '#F5E7DA', tintDark: '#2F2418' },
  { src: '/avatars/23-lavender-coach.webp', tint: '#EDE5F8', tintDark: '#28213B' },
  { src: '/avatars/24-turquoise-data.webp', tint: '#D9F1EF', tintDark: '#132F2C' },
]

export const PORTRAIT_COUNT = PORTRAITS.length

/**
 * FNV-1a over the WHOLE string. Agent ids are cuids — a leading 'c' plus a
 * base36 timestamp — so ids minted in the same session share roughly ten
 * leading characters. Any hash that samples the front of the string gives a
 * whole workspace one face.
 *
 * Deliberately duplicated from lib/agents/avatar.ts rather than shared: that
 * module's hash feeds the legacy part indices, and changing either one must
 * never silently re-face agents through the other.
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** The portrait for a seed. Stable forever for a given seed. */
export function portraitFor(seed: string): Portrait {
  return PORTRAITS[fnv1a(seed) % PORTRAIT_COUNT]
}
