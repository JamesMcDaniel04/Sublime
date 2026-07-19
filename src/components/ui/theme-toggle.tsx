'use client'

import { useEffect, useState } from 'react'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Renders a neutral placeholder until mounted: next-themes only knows the
// resolved theme on the client, and rendering the "wrong" icon during SSR
// would flash on hydration.
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const isDark = mounted && resolvedTheme === 'dark'
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  )
}

const THEME_OPTIONS = [
  { value: 'system', label: 'System', detail: 'Match your device', icon: Monitor },
  { value: 'light', label: 'Light', detail: 'Always use light mode', icon: Sun },
  { value: 'dark', label: 'Dark', detail: 'Always use dark mode', icon: Moon },
] as const

/** Full appearance control for Settings; theme changes are persisted by next-themes. */
export function ThemeSelector() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const activeTheme = mounted ? (theme || 'system') : 'system'

  return (
    <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Color theme">
      {THEME_OPTIONS.map((option) => {
        const Icon = option.icon
        const selected = activeTheme === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(option.value)}
            className={cn(
              'group relative flex min-h-28 flex-col items-start rounded-xl border p-4 text-left transition-all duration-base ease-out-quart',
              'hover:-translate-y-0.5 hover:border-foreground/25 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              selected ? 'border-foreground/30 bg-accent shadow-2' : 'border-border bg-background',
            )}
          >
            <span className={cn(
              'mb-5 flex h-9 w-9 items-center justify-center rounded-lg border transition-colors',
              selected ? 'border-foreground/20 bg-foreground text-background' : 'border-border bg-muted text-muted-foreground group-hover:text-foreground',
            )}>
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold text-foreground">{option.label}</span>
            <span className="mt-0.5 text-xs text-muted-foreground">{option.detail}</span>
            {selected && (
              <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-background">
                <Check className="h-3 w-3" aria-hidden="true" />
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
