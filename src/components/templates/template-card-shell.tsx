import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * The card chrome shared by the agent, flow and goal template catalogues:
 * gradient accent bar, badge row, icon tile + title, clamped description, an
 * optional tools slot and a CTA.
 *
 * The caller owns the wrapper element — agent cards wrap this in a Link, goal
 * template cards wrap it in a button — so each keeps its own accessibility
 * semantics without a polymorphic `as` prop.
 */

export type Accent = {
  bar: string
  tile: string
  badge: string
  ring: string
}

export const ACCENTS: readonly Accent[] = [
  { bar: 'from-sky-500 to-cyan-400', tile: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300', badge: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300', ring: 'hover:ring-sky-300/70 dark:hover:ring-sky-500/40' },
  { bar: 'from-violet-500 to-fuchsia-400', tile: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300', badge: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300', ring: 'hover:ring-violet-300/70 dark:hover:ring-violet-500/40' },
  { bar: 'from-emerald-500 to-teal-400', tile: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300', badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300', ring: 'hover:ring-emerald-300/70 dark:hover:ring-emerald-500/40' },
  { bar: 'from-amber-500 to-orange-400', tile: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300', badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300', ring: 'hover:ring-amber-300/70 dark:hover:ring-amber-500/40' },
  { bar: 'from-rose-500 to-pink-400', tile: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300', badge: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300', ring: 'hover:ring-rose-300/70 dark:hover:ring-rose-500/40' },
  // Cyan, not indigo: the tailwind config remaps `indigo-*` to neutral theme
  // tokens, so an indigo accent renders gray (and this entry lacked dark styles).
  { bar: 'from-cyan-500 to-teal-400', tile: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-500/15 dark:text-cyan-300', badge: 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-300', ring: 'hover:ring-cyan-300/70 dark:hover:ring-cyan-500/40' },
] as const

export function hashIndex(seed: string, mod: number): number {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  return hash % mod
}

export function accentFor(category: string): Accent {
  return ACCENTS[hashIndex(category || 'default', ACCENTS.length)]
}

export function TemplateCardShell({
  accent,
  icon: Icon,
  title,
  description,
  descriptionClamp = 3,
  badges,
  tools,
  cta,
}: {
  accent: Accent
  icon: LucideIcon
  title: string
  description: string
  descriptionClamp?: 2 | 3
  badges: ReactNode
  tools?: ReactNode
  cta: ReactNode
}) {
  return (
    <Card className={cn(
      'group relative h-full overflow-hidden border-border/60 transition-all duration-200',
      'hover:-translate-y-0.5 hover:shadow-lg hover:ring-1',
      accent.ring,
    )}>
      <div className={cn('absolute inset-x-0 top-0 h-1 bg-gradient-to-r opacity-80 transition-opacity group-hover:opacity-100', accent.bar)} />
      <CardHeader className="space-y-2.5 pt-5">
        <div className="flex flex-wrap items-center gap-1.5">{badges}</div>
        <div className="flex items-start gap-2.5">
          <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105', accent.tile)}>
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <CardTitle className="min-w-0 text-base leading-snug">{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className={cn('text-sm text-muted-foreground', descriptionClamp === 2 ? 'line-clamp-2' : 'line-clamp-3')}>
          {description}
        </p>
        {tools}
        {cta}
      </CardContent>
    </Card>
  )
}
