/**
 * Category → accent classes and icon. An explicit Record rather than the agent
 * card's hashIndex: hashing seven categories over six accents would assign
 * collisions arbitrarily, and Revenue and Cost in particular need to read as
 * visually distinct. Class shapes mirror ACCENTS in template-card-shell.
 */
import {
  HeartHandshake,
  Megaphone,
  PiggyBank,
  Rocket,
  ShieldCheck,
  Target,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import type { GoalTemplateCategory } from '@/lib/goals/goal-templates'

export type CategoryAccent = {
  bar: string
  tile: string
  badge: string
  ring: string
}

export const CATEGORY_ACCENTS: Record<GoalTemplateCategory, CategoryAccent> = {
  Revenue: {
    bar: 'from-emerald-500 to-teal-400',
    tile: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
    ring: 'hover:ring-emerald-300/70 dark:hover:ring-emerald-500/40',
  },
  Pipeline: {
    bar: 'from-sky-500 to-cyan-400',
    tile: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    badge: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300',
    ring: 'hover:ring-sky-300/70 dark:hover:ring-sky-500/40',
  },
  Cost: {
    bar: 'from-amber-500 to-orange-400',
    tile: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
    ring: 'hover:ring-amber-300/70 dark:hover:ring-amber-500/40',
  },
  Retention: {
    bar: 'from-rose-500 to-pink-400',
    tile: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
    badge: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
    ring: 'hover:ring-rose-300/70 dark:hover:ring-rose-500/40',
  },
  Delivery: {
    bar: 'from-violet-500 to-fuchsia-400',
    tile: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
    badge: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300',
    ring: 'hover:ring-violet-300/70 dark:hover:ring-violet-500/40',
  },
  // Cyan, not indigo: tailwind.config.js remaps `indigo-*` to neutral theme
  // tokens (the retired accent), so an indigo accent silently renders GRAY.
  Quality: {
    bar: 'from-cyan-500 to-teal-400',
    tile: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-500/15 dark:text-cyan-300',
    badge: 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-300',
    ring: 'hover:ring-cyan-300/70 dark:hover:ring-cyan-500/40',
  },
  Demand: {
    bar: 'from-fuchsia-500 to-purple-400',
    tile: 'bg-fuchsia-100 text-fuchsia-600 dark:bg-fuchsia-500/15 dark:text-fuchsia-300',
    badge: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-500/30 dark:bg-fuchsia-500/10 dark:text-fuchsia-300',
    ring: 'hover:ring-fuchsia-300/70 dark:hover:ring-fuchsia-500/40',
  },
}

export const CATEGORY_ICONS: Record<GoalTemplateCategory, LucideIcon> = {
  Revenue: TrendingUp,
  Pipeline: Target,
  Cost: PiggyBank,
  Retention: HeartHandshake,
  Delivery: Rocket,
  Quality: ShieldCheck,
  Demand: Megaphone,
}
