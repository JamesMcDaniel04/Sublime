import type { Metadata } from 'next'
import { Anonymous_Pro, Geist } from 'next/font/google'
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

export const metadata: Metadata = {
  title: 'Sublime',
  description:
    'Know whether your team runs the plays you roll out. Sublime turns revenue standards into work agents produce, then shows you who ran it and what your team is telling you about your ICP.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geist.variable} ${anonymousPro.variable}`}>
      <body>
        {/* Chrome and the billing gate belong to the (app) route group; the
            (public) group renders its own bare <main>. The root layout stays
            free of cookies()/DB access so /about, /contact, /privacy, and
            /terms can still render statically. */}
        <ClientProviders>{children}</ClientProviders>
        <Analytics />
      </body>
    </html>
  )
}
