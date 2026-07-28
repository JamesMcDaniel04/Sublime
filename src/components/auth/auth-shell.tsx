'use client'

// Landing-styled chrome for the auth pages: the same .lovable-landing scoped
// theme, Geist type, and persisted light/dark toggle as the marketing pages,
// so landing → sign in → sign up never switches visual worlds. The wordmark
// sits quietly in the top-left corner (linking home) instead of a page header.
import Link from 'next/link'
import { Geist } from 'next/font/google'
import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { StackedLogo } from '@/components/landing/stacked-logo'
import '@/app/(public)/landing.css'

const geist = Geist({ subsets: ['latin'], display: 'swap' })

const THEME_STORAGE_KEY = 'sublime-landing-theme'

export function AuthShell({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow?: string
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  const [theme, setThemeState] = useState<'light' | 'dark'>('dark')

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') setThemeState(stored)
  }, [])

  const setTheme = (next: 'light' | 'dark') => {
    setThemeState(next)
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
  }

  const isDark = theme === 'dark'

  return (
    <div
      className={`lovable-landing ${geist.className} ${isDark ? 'dark' : ''} relative flex min-h-screen items-center justify-center bg-background px-4 py-16 text-foreground`}
    >
      <Link href="/" className="absolute left-6 top-5 flex items-center gap-2">
        <StackedLogo size={16} />
        <span className="text-[13px] font-bold uppercase tracking-[0.08em] text-foreground">Sublime</span>
      </Link>
      <button
        onClick={() => setTheme(isDark ? 'light' : 'dark')}
        className="absolute right-6 top-5 flex h-8 w-8 items-center justify-center text-foreground/70 transition-colors hover:text-foreground"
        title="Toggle theme"
      >
        <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
        <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      </button>

      {/* [&_button]:rounded-none + [&_input]:rounded-none keep every control
          inside the card square, matching the landing's sharp-corner grammar
          without forking the shared Button/Input components. */}
      <div className="w-full max-w-[400px] border border-border bg-card p-8 [&_button]:rounded-none [&_input]:rounded-none">
        {eyebrow && <p className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground">{eyebrow}</p>}
        <h1 className="mt-3 text-[24px] font-[500] leading-[1.15] tracking-[-0.03em] text-foreground">{title}</h1>
        {subtitle && <p className="mt-2 text-[13px] leading-[1.6] text-muted-foreground">{subtitle}</p>}
        <div className="mt-7">{children}</div>
      </div>
    </div>
  )
}
