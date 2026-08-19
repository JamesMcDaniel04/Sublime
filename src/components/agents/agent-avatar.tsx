import { avatarPartsFor, avatarSeedFor, type AvatarParts } from '@/lib/agents/avatar'
import { cn } from '@/lib/utils'

/**
 * The portrait shown for an agent on the roster.
 *
 * Flat filled shapes, no outline strokes: the same SVG renders at 32px in a
 * sidebar row and 96px on a roster tile, and stroked features go muddy at the
 * small end. The circular crop with shoulders cut off at the bottom edge is
 * what makes these read as staff headshots in a directory rather than as chat
 * avatars — the framing does the work, not decoration.
 *
 * Pure (no hooks, no client state) so it renders in server and client trees
 * alike, and deterministic via lib/agents/avatar.ts.
 */

/** Real human range, desaturated enough not to fight the UI's neutrals. */
const SKIN = ['#F4D6C0', '#EBBE9F', '#DCA57F', '#C68763', '#AA6D4D', '#8B5638', '#6B4227', '#4A2E1B']

const HAIR = ['#171721', '#3C3C46', '#6B4227', '#8A5638', '#B08341', '#ABABAD']

/** Backdrop tints drawn from the brand family plus the accent rotation the
 *  template cards already use, so portraits sit inside the existing palette. */
const BACKDROP = ['#DBEBF2', '#F1F2F5', '#E4E9F7', '#E6F2EC', '#F7EDE2', '#F3E8EE']

const ATTIRE = ['#447C93', '#3C3C46', '#55555E', '#2B6178', '#6B7280', '#4B5563', '#5A6B7A', '#18485C']

const SIZES = { sm: 32, md: 48, lg: 96 } as const

export type AgentAvatarStatus = 'running' | 'waiting' | 'failed' | 'idle'

/** Status is carried by a ring rather than a badge — it never hides the face. */
const STATUS_RING: Record<AgentAvatarStatus, string> = {
  running: 'ring-2 ring-offset-2 ring-horizon-500 animate-pulse-ring',
  waiting: 'ring-2 ring-offset-2 ring-amber-400',
  failed: 'ring-2 ring-offset-2 ring-red-500',
  idle: 'ring-1 ring-border',
}

const STATUS_TITLE: Record<AgentAvatarStatus, string> = {
  running: 'Running now',
  waiting: 'Waiting for your input',
  failed: 'Last run failed',
  idle: 'Idle',
}

/**
 * Hair that falls BEHIND the head: length, volume, silhouette.
 *
 * Drawn before the face. Rendering these on top instead put long hair over the
 * ears, where rectangular side panels read as headphone cups rather than hair.
 */
function HairBack({ style, color }: { style: number; color: string }) {
  switch (style) {
    case 3: // full curls — volume around the skull
      return (
        <g fill={color}>
          <circle cx="34" cy="34" r="13" />
          <circle cx="50" cy="26" r="14" />
          <circle cx="66" cy="34" r="13" />
        </g>
      )
    case 5: // ponytail, gathered behind one shoulder
      return <path d="M64 30c10 2 15 12 13 26-2 8-6 13-11 15 4-10 4-21 0-30z" fill={color} />
    case 6: // long and straight, past the shoulders
      return <path d="M26 44c0-15 11-25 24-25s24 10 24 25v38H26z" fill={color} />
    case 7: // bob, turning in at the jaw
      return <path d="M25 45c0-16 11-26 25-26s25 10 25 26v11c0 7-5 12-12 12H37c-7 0-12-5-12-12z" fill={color} />
    case 9: // locs falling either side
      return (
        <g fill={color}>
          <path d="M26 44c0-15 11-25 24-25s24 10 24 25v22H26z" />
          <circle cx="27" cy="60" r="5" />
          <circle cx="27" cy="70" r="5" />
          <circle cx="73" cy="60" r="5" />
          <circle cx="73" cy="70" r="5" />
        </g>
      )
    default:
      return null
  }
}

/** The cap, fringe and hairline, drawn over the forehead. */
function HairFront({ style, color }: { style: number; color: string }) {
  switch (style) {
    case 0: // short crop
      return <path d="M29 40c0-13 9-21 21-21s21 8 21 21c0-8-9-11-21-11s-21 3-21 11z" fill={color} />
    case 1: // buzz
      return <path d="M30 41c0-12 9-20 20-20s20 8 20 20c-3-6-10-9-20-9s-17 3-20 9z" fill={color} />
    case 2: // side part
      return <path d="M29 41c0-13 9-22 21-22 12 0 19 7 21 17-6-6-14-8-24-6-7 1-13 5-18 11z" fill={color} />
    case 3: // curls sit behind; a soft hairline keeps the forehead from floating
      return <path d="M31 39c3-9 10-14 19-14s16 5 19 14c-5-6-11-9-19-9s-14 3-19 9z" fill={color} />
    case 4: // bun
      return (
        <g fill={color}>
          <circle cx="50" cy="14" r="7" />
          <path d="M29 40c0-13 9-21 21-21s21 8 21 21c0-8-9-11-21-11s-21 3-21 11z" />
        </g>
      )
    case 8: // close shave — the hairline itself is the shape
      return <path d="M32 38c4-5 10-8 18-8s14 3 18 8c-2-11-9-17-18-17s-16 6-18 17z" fill={color} />
    default: // 5, 6, 7, 9 — the length is behind; the front is the same soft cap
      return <path d="M29 41c0-14 9-22 21-22s21 8 21 22c0-8-9-12-21-12s-21 4-21 12z" fill={color} />
  }
}

function Eyes({ style }: { style: number }) {
  const ink = '#171721'
  switch (style) {
    case 0:
      return (
        <g fill={ink}>
          <circle cx="42" cy="46" r="2.4" />
          <circle cx="58" cy="46" r="2.4" />
        </g>
      )
    case 1:
      return (
        <g fill={ink}>
          <ellipse cx="42" cy="46" rx="3" ry="2.2" />
          <ellipse cx="58" cy="46" rx="3" ry="2.2" />
        </g>
      )
    case 2:
      return (
        <g fill={ink}>
          <circle cx="42" cy="46" r="3.2" />
          <circle cx="58" cy="46" r="3.2" />
        </g>
      )
    case 3: // relaxed, looking down at work
      return (
        <g fill={ink}>
          <path d="M39 46c1.8-2 4.4-2 6 0z" />
          <path d="M55 46c1.8-2 4.4-2 6 0z" />
        </g>
      )
    default:
      return (
        <g fill={ink}>
          <rect x="39.5" y="44.8" width="5" height="2.4" rx="1.2" />
          <rect x="55.5" y="44.8" width="5" height="2.4" rx="1.2" />
        </g>
      )
  }
}

function Brows({ style, color }: { style: number; color: string }) {
  if (style === 0) {
    return (
      <g fill={color}>
        <rect x="38.5" y="40" width="7" height="1.8" rx="0.9" />
        <rect x="54.5" y="40" width="7" height="1.8" rx="0.9" />
      </g>
    )
  }
  if (style === 1) {
    return (
      <g fill={color}>
        <rect x="38.5" y="38.6" width="7" height="1.8" rx="0.9" />
        <rect x="54.5" y="38.6" width="7" height="1.8" rx="0.9" />
      </g>
    )
  }
  return (
    <g fill={color}>
      <rect x="38.5" y="40" width="7" height="1.8" rx="0.9" transform="rotate(-8 42 41)" />
      <rect x="54.5" y="40" width="7" height="1.8" rx="0.9" transform="rotate(8 58 41)" />
    </g>
  )
}

function Mouth({ style }: { style: number }) {
  const ink = '#8A5638'
  switch (style) {
    case 0:
      return <rect x="46" y="56" width="8" height="1.8" rx="0.9" fill={ink} />
    case 1:
      return <path d="M44 55c2 3.2 10 3.2 12 0-1 4.4-11 4.4-12 0z" fill={ink} />
    case 2:
      return <path d="M44.5 55h11a5.5 5.5 0 0 1-11 0z" fill={ink} />
    case 3:
      return <rect x="47.5" y="56" width="5" height="1.8" rx="0.9" fill={ink} />
    default:
      return <path d="M45 56c2.5-1.6 7.5-1.6 10 0-2.5 1.2-7.5 1.2-10 0z" fill={ink} />
  }
}

/** Shoulders read as a cropped headshot: they run past the circle and are clipped. */
function Attire({ style, color }: { style: number; color: string }) {
  switch (style) {
    case 0: // crew neck
      return <path d="M22 100c0-14 12-22 28-22s28 8 28 22z" fill={color} />
    case 1: // collared shirt
      return (
        <g>
          <path d="M22 100c0-14 12-22 28-22s28 8 28 22z" fill={color} />
          <path d="M44 79l6 8 6-8-6-3z" fill="#FFFFFF" opacity="0.9" />
        </g>
      )
    case 2: // blazer with lapels
      return (
        <g>
          <path d="M22 100c0-14 12-22 28-22s28 8 28 22z" fill={color} />
          <path d="M44 78l6 10-10 12h-6zM56 78l-6 10 10 12h6z" fill="#171721" opacity="0.35" />
        </g>
      )
    case 3: // turtleneck
      return (
        <g>
          <path d="M22 100c0-14 12-22 28-22s28 8 28 22z" fill={color} />
          <rect x="41" y="72" width="18" height="9" rx="4" fill={color} />
        </g>
      )
    case 4: // v-neck
      return (
        <g>
          <path d="M22 100c0-14 12-22 28-22s28 8 28 22z" fill={color} />
          <path d="M43 79l7 11 7-11z" fill="#171721" opacity="0.25" />
        </g>
      )
    default: // hoodie
      return (
        <g>
          <path d="M22 100c0-15 12-23 28-23s28 8 28 23z" fill={color} />
          <path d="M40 78c3 6 17 6 20 0l4 2c-4 8-24 8-28 0z" fill="#171721" opacity="0.2" />
        </g>
      )
  }
}

function Portrait({ parts, clipId }: { parts: AvatarParts; clipId: string }) {
  const skin = SKIN[parts.skin]
  const hair = HAIR[parts.hairColor]
  return (
    <svg viewBox="0 0 100 100" className="h-full w-full">
      <defs>
        <clipPath id={clipId}>
          <circle cx="50" cy="50" r="50" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <circle cx="50" cy="50" r="50" fill={BACKDROP[parts.background]} />
        {/* Length and volume go down first, so the face and ears sit in front of
            them — hair drawn over the ears reads as headphones, not hair. */}
        <HairBack style={parts.hair} color={hair} />
        {/* Neck before the collar so the garment overlaps it. */}
        <path d="M44 62h12v14H44z" fill={skin} />
        <Attire style={parts.attire} color={ATTIRE[parts.attireColor]} />
        <circle cx="29" cy="47" r="4" fill={skin} />
        <circle cx="71" cy="47" r="4" fill={skin} />
        <ellipse cx="50" cy="45" rx="21" ry="24" fill={skin} />
        <Brows style={parts.brows} color={hair} />
        <Eyes style={parts.eyes} />
        <Mouth style={parts.mouth} />
        <HairFront style={parts.hair} color={hair} />
      </g>
    </svg>
  )
}

/** SVG ids are document-global, so 40 tiles sharing one clip id would all clip
 *  to whichever mounted last. Derive it from the seed and strip anything that
 *  isn't legal in an id. */
function clipIdFor(seed: string): string {
  return `agent-avatar-${seed.replace(/[^A-Za-z0-9_-]/g, '') || 'default'}`
}

export function AgentAvatar({
  agent,
  size = 'md',
  status,
  badge,
  name,
  className,
}: {
  agent: { id: string; avatarSeed?: string | null }
  size?: keyof typeof SIZES
  status?: AgentAvatarStatus | null
  /** The agent's chosen emoji, kept as a corner mark rather than discarded. */
  badge?: string
  /** Provide when no adjacent text names the agent; otherwise the portrait is decorative. */
  name?: string
  className?: string
}) {
  const seed = avatarSeedFor(agent)
  const parts = avatarPartsFor(seed)
  const pixels = SIZES[size]
  const labelled = Boolean(name)
  return (
    <span
      className={cn('relative inline-block shrink-0', className)}
      style={{ width: pixels, height: pixels }}
      {...(labelled
        ? { role: 'img', 'aria-label': status ? `${name} — ${STATUS_TITLE[status]}` : name }
        : { 'aria-hidden': true })}
    >
      <span
        className={cn(
          'block h-full w-full overflow-hidden rounded-full bg-muted ring-offset-background',
          status ? STATUS_RING[status] : 'ring-1 ring-border',
        )}
        title={status ? STATUS_TITLE[status] : undefined}
      >
        <Portrait parts={parts} clipId={clipIdFor(seed)} />
      </span>
      {badge && size !== 'sm' && (
        <span
          className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full border border-border bg-card shadow-1"
          style={{ width: pixels * 0.34, height: pixels * 0.34, fontSize: pixels * 0.2 }}
          aria-hidden
        >
          {badge}
        </span>
      )}
    </span>
  )
}
