import { avatarSeedFor } from '@/lib/agents/avatar'
import { portraitFor } from '@/lib/agents/avatar-portraits'
import { cn } from '@/lib/utils'

/**
 * The portrait shown for an agent.
 *
 * Two shapes, because the portrait does two different jobs. `circle` is the
 * directory headshot used in dense rows — a sidebar entry, a picker chip —
 * where a round crop reads as "a person" at 20–32px. `tile` is the roster
 * card's hero: a large rounded square on a tint drawn from the portrait
 * itself, where the character is the primary content rather than a marker
 * beside a name.
 *
 * The image is served from /public and chosen deterministically from the
 * agent's seed (lib/agents/avatar-portraits.ts), so a face is stable across
 * devices and deploys with nothing stored on the row.
 */

const SIZES = { xs: 20, sm: 32, md: 48, lg: 96, xl: 132 } as const

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

export function AgentAvatar({
  agent,
  size = 'md',
  shape = 'circle',
  status,
  badge,
  name,
  className,
}: {
  agent: { id: string; avatarSeed?: string | null }
  size?: keyof typeof SIZES
  shape?: 'circle' | 'tile'
  status?: AgentAvatarStatus | null
  /** The agent's chosen emoji, kept as a corner mark rather than discarded. */
  badge?: string
  /** Provide when no adjacent text names the agent; otherwise the portrait is decorative. */
  name?: string
  className?: string
}) {
  const seed = avatarSeedFor(agent)
  const portrait = portraitFor(seed)
  const pixels = SIZES[size]
  const labelled = Boolean(name)
  const tile = shape === 'tile'

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
          'agent-tint block h-full w-full overflow-hidden',
          tile ? 'rounded-2xl' : 'rounded-full',
          // The tile shape carries status with a DOT (drawn by the caller), so a
          // ring here would say the same thing twice — and a 2px accent ring
          // around a rounded square reads as a rendering artifact rather than a
          // state. The circle shape has no room for a dot, so it keeps the ring.
          tile ? '' : status ? STATUS_RING[status] : 'ring-1 ring-border',
        )}
        // The two hues arrive as custom properties; `.agent-tint` in globals.css
        // picks between them per theme. Inline because the tint is per-portrait
        // DATA (24 of them), not a design token.
        style={
          {
            '--agent-tint-light': portrait.tint,
            '--agent-tint-dark': portrait.tintDark,
          } as React.CSSProperties
        }
        title={status ? STATUS_TITLE[status] : undefined}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- next/image has
            zero usages in this codebase, and it would buy nothing here: these
            are 24 fixed, already-compressed 512px webps rendered at 20-132px,
            lazy-loaded and cached by the CDN. Routing them through the image
            optimizer would add per-image billing on Vercel for a file that is
            already ~40KB. Revisit if portraits ever become user-uploaded. */}
        <img
          src={portrait.src}
          alt=""
          width={pixels}
          height={pixels}
          loading="lazy"
          decoding="async"
          className={cn('h-full w-full object-cover', tile ? 'scale-105' : 'scale-110')}
        />
      </span>
      {badge && size !== 'sm' && size !== 'xs' && (
        <span
          className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full border border-border bg-card shadow-1"
          style={{ width: pixels * 0.3, height: pixels * 0.3, fontSize: pixels * 0.17 }}
          aria-hidden
        >
          {badge}
        </span>
      )}
    </span>
  )
}
