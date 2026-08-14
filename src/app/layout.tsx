import type { Metadata } from 'next'
import { Anonymous_Pro, Geist } from 'next/font/google'
import { headers } from 'next/headers'
import { Analytics } from '@vercel/analytics/next'
import { ClientProviders } from '@/components/providers/client-providers'
import './globals.css'

// PRIMARY DISPLAY/BODY — Geist, the landing page's typeface, so the marketing
// site and the signed-in product share one typographic voice. (The previous
// KMR Waldenburg brand font still lives in public/fonts if ever needed.)
const geist = Geist({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  fallback: ['Arimo', 'system-ui', 'sans-serif'],
})

// PRIMARY MONO — Anonymous Pro (brand tagline + uppercase micro-labels).
const anonymousPro = Anonymous_Pro({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-mono',
  display: 'swap',
})

// Every route renders per-request, and this is NOT optional — it is what makes
// the CSP satisfiable. The middleware stamps a fresh `script-src 'nonce-<random>'`
// on every response, but Next can only put that nonce on its inline scripts
// while rendering dynamically; a prerendered page was built without a request,
// so its HTML carries no nonce at all. The two together are unsatisfiable: the
// external chunks still load under 'self', but the inline
// `self.__next_f.push(...)` RSC payload is blocked, React boots with nothing to
// render, and the route serves a blank white page. That is what /auth/login,
// /auth/signup and the 404 page were doing in production; / escaped it only
// because it had already opted out of prerendering for its own reasons.
// Declared at the root so the framework-generated /_not-found is covered too —
// it has no layout or page file of its own to carry the directive.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sublime',
  description:
    'Agents that achieve your goals. Sublime deploys specialized agents against the goals that matter — quota, ARR, KPIs — and proves the ROI of every run.',
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Next nonces its own inline scripts from this header, but third-party
  // providers that inline a script have to be handed the nonce explicitly.
  const nonce = (await headers()).get('x-nonce') ?? undefined

  return (
    <html lang="en" suppressHydrationWarning className={`${geist.variable} ${anonymousPro.variable}`}>
      <body>
        {/* WCAG 2.4.1 Bypass Blocks. Both layouts already render
            <main id="main-content">; what was missing was the link to it, so a
            keyboard or switch user tabbed the whole sidebar on every single
            navigation before reaching content.

            First element in the body so it is the first tab stop. sr-only until
            focused: visible when it matters, invisible when it doesn't — a
            permanently visible skip link is the usual reason teams delete it. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:border focus:border-border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          Skip to main content
        </a>
        {/* Chrome and the billing gate belong to the (app) route group; the
            (public) group renders its own bare <main>. The root layout stays
            free of cookies()/DB access — not for static rendering (the CSP
            nonce rules that out, see `dynamic` above) but to keep marketing
            routes off the database. */}
        <ClientProviders nonce={nonce}>{children}</ClientProviders>
        <Analytics />
      </body>
    </html>
  )
}
