'use client'

import { useEffect, useRef } from 'react'

/**
 * Cloudflare Turnstile challenge.
 *
 * Renders NOTHING when NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset, so a developer
 * machine with no production secrets sees exactly the form it saw before. The
 * consuming form decides what an absent token means — see the `optional` note
 * on `onToken` below.
 *
 * Explicit render mode (rather than the auto-scanning `cf-turnstile` class) so
 * the widget's lifetime is tied to this component: React 19 strict mode mounts
 * effects twice in development, and auto-mode would leave a second orphaned
 * challenge behind on every remount.
 *
 * The script host is allow-listed in src/lib/security/csp.ts under BOTH
 * script-src and frame-src; the widget is an iframe, so dropping either one
 * renders a permanently blank box with only a console error.
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

declare global {
  interface Window {
    turnstile?: {
      render: (
        element: HTMLElement,
        options: {
          sitekey: string
          callback: (token: string) => void
          'expired-callback'?: () => void
          'error-callback'?: () => void
          theme?: 'auto' | 'light' | 'dark'
        },
      ) => string
      remove: (widgetId: string) => void
    }
  }
}

let scriptPromise: Promise<void> | null = null

/** Load the Turnstile script exactly once per document. */
function loadTurnstile(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.turnstile) return Promise.resolve()
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('turnstile script failed')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error('turnstile script failed')), { once: true })
    document.head.appendChild(script)
  })
  return scriptPromise
}

export function turnstileEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY)
}

/**
 * `onToken` receives the solved token, or `null` when the challenge expires or
 * errors — so a form that gates its submit button re-disables it rather than
 * submitting a stale token Cloudflare will reject.
 */
export function TurnstileWidget({ onToken }: { onToken: (token: string | null) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Held in a ref so the mount effect never re-runs when the parent re-renders
  // with a new inline callback — a re-run would tear down a solved challenge.
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

  useEffect(() => {
    if (!siteKey || !containerRef.current) return
    let widgetId: string | undefined
    let cancelled = false

    void loadTurnstile()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
        })
      })
      .catch(() => {
        // A blocked or failed script must not wedge the form. The server still
        // enforces the check when configured, so a missing token is refused
        // there rather than silently accepted here.
        onTokenRef.current(null)
      })

    return () => {
      cancelled = true
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId)
    }
  }, [siteKey])

  if (!siteKey) return null
  return <div ref={containerRef} className="flex justify-center" />
}
