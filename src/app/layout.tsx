import type { Metadata } from 'next'
import { Anonymous_Pro, Geist } from 'next/font/google'
import { ClientProviders } from '@/components/providers/client-providers'
import { AppShell } from '@/components/layout/app-shell'
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
  description: 'Build, run, and review AI agents connected to your tools.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geist.variable} ${anonymousPro.variable}`}>
      <body>
        <ClientProviders>
          <AppShell>{children}</AppShell>
        </ClientProviders>
      </body>
    </html>
  )
}
