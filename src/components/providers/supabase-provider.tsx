'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'

const supabase = createClient()

// Pages a signed-out user may see (mirrors the middleware allow-list).
const PUBLIC_PATHS = new Set(['/', '/privacy', '/terms', '/auth-code-error'])

/** The canonical app origin for auth redirects: the configured production URL
 *  when set (so links never point at localhost/preview), else the live origin. */
function appOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, '')
  if (configured) return configured
  return typeof window !== 'undefined' ? window.location.origin : ''
}

type SupabaseContext = {
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => ReturnType<typeof supabase.auth.signInWithPassword>
  signUp: (email: string, password: string, options?: { data?: Record<string, unknown> }) => ReturnType<typeof supabase.auth.signUp>
  signOut: () => Promise<void>
}

const Context = createContext<SupabaseContext | null>(null)

export function SupabaseProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Authentication check timed out')), 8_000)
    })
    void Promise.race([supabase.auth.getUser(), timeout])
      .then(({ data }) => { if (active) setUser(data.user) })
      .catch(() => { if (active) setUser(null) })
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId)
        if (active) setLoading(false)
      })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })
    return () => {
      active = false
      if (timeoutId) clearTimeout(timeoutId)
      data.subscription.unsubscribe()
    }
  }, [])

  // Back-forward cache guard. Pressing "Back" after sign-out can restore an
  // authenticated page straight from the bfcache WITHOUT hitting the server, so
  // the middleware redirect never runs. On any bfcache restore — and whenever a
  // backgrounded protected tab is refocused — we hide the page IMMEDIATELY (so
  // no protected content flashes), re-check the session from local storage, and
  // either reveal it or bounce to sign-in. Public pages are exempt.
  useEffect(() => {
    const onProtectedPath = () => {
      const path = window.location.pathname
      return !PUBLIC_PATHS.has(path) && !path.startsWith('/auth/')
    }
    const reveal = () => {
      document.documentElement.style.visibility = ''
    }
    const bounceIfSignedOut = async () => {
      const { data } = await supabase.auth.getSession()
      if (!data.session) {
        window.location.replace(`/auth/login?return_to=${encodeURIComponent(window.location.pathname)}`)
        return false
      }
      return true
    }
    // bfcache restore shows STALE cached content, so hide first to prevent a
    // flash, then verify.
    const guardBfcache = async () => {
      if (!onProtectedPath()) return
      document.documentElement.style.visibility = 'hidden'
      try {
        if (await bounceIfSignedOut()) reveal()
      } catch {
        window.location.reload() // couldn't verify — let the server (middleware) decide
      }
    }
    // A refocused live tab shows CURRENT content, so no hide needed (no flicker);
    // catch a sign-out that happened in another tab.
    const guardBackground = () => {
      if (onProtectedPath()) void bounceIfSignedOut().catch(() => undefined)
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void guardBfcache()
      else reveal()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') guardBackground()
    }
    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('visibilitychange', onVisibility)
      reveal()
    }
  }, [])

  const value = useMemo<SupabaseContext>(() => ({
    user,
    loading,
    signIn: (email, password) => supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    }),
    signUp: (email, password, options) => supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        data: options?.data,
        // Prefer the configured production URL so confirmation links never point
        // at localhost or a preview origin; fall back to the current origin.
        emailRedirectTo: `${appOrigin()}/auth/callback`,
      },
    }),
    signOut: async () => {
      const { error } = await supabase.auth.signOut()
      if (error) throw error
    },
  }), [loading, user])

  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useSupabase() {
  const context = useContext(Context)
  if (!context) throw new Error('useSupabase must be used within SupabaseProvider')
  return context
}
