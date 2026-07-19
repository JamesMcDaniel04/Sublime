'use client'

// Shared chrome for marketing subpages (/about, /contact, /privacy, /terms):
// the same .lovable-landing scoped theme, nav, and footer as the landing page,
// including its persisted light/dark toggle (same localStorage key), so moving
// between the landing and these pages never switches visual worlds.
import Link from 'next/link'
import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { StackedLogo } from './stacked-logo'

const THEME_STORAGE_KEY = 'sublime-landing-theme'

export function MarketingShell({
  fontClassName = '',
  children,
}: {
  fontClassName?: string
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
      className={`lovable-landing ${fontClassName} ${isDark ? 'dark' : ''} min-h-screen bg-background text-foreground overflow-x-hidden flex flex-col`}
    >
      {/* Nav — mirrors the landing page nav */}
      <nav className="fixed top-0 z-50 w-full bg-background border-b border-border px-6">
        <div className="mx-auto flex h-[56px] max-w-[1200px] items-center justify-between">
          <Link href="/" className="flex items-center gap-2 -ml-0.5">
            <StackedLogo size={16} />
            <span className="text-[14px] font-bold text-foreground tracking-[0.08em] uppercase">Sublime</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/#pricing"
              className="text-[13px] text-foreground/70 hover:text-foreground transition-colors h-8 px-3 flex items-center"
            >
              Pricing
            </Link>
            <button
              onClick={() => setTheme(isDark ? 'light' : 'dark')}
              className="relative h-8 w-8 flex items-center justify-center text-foreground/70 hover:text-foreground transition-colors"
              title="Toggle theme"
            >
              <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            </button>
            <Link href="/auth/login">
              <button className="text-[13px] text-foreground/70 hover:text-foreground transition-colors h-8 px-3">
                Log in
              </button>
            </Link>
            <Link href="/auth/signup">
              <button className="text-[13px] h-8 px-3 border border-foreground/40 text-foreground hover:bg-foreground hover:text-background transition-colors">
                Sign up
              </button>
            </Link>
          </div>
        </div>
      </nav>

      <main className="flex-1 pt-[56px]">{children}</main>

      {/* Footer — mirrors the landing page footer */}
      <div className="border-t border-border">
        <div className="mx-auto max-w-[1200px] px-6 py-6 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 -ml-0.5">
            <StackedLogo size={16} />
            <span className="text-[12px] font-bold text-foreground uppercase tracking-[0.08em]">Sublime</span>
          </Link>
          <div className="flex items-center gap-5">
            <Link href="/about" className="text-[12px] text-muted-foreground hover:text-foreground transition-colors">
              About
            </Link>
            <Link href="/contact" className="text-[12px] text-muted-foreground hover:text-foreground transition-colors">
              Contact
            </Link>
            <Link href="/privacy" className="text-[12px] text-muted-foreground hover:text-foreground transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="text-[12px] text-muted-foreground hover:text-foreground transition-colors">
              Terms
            </Link>
            <span className="text-[12px] text-muted-foreground">© {new Date().getFullYear()}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
