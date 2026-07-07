import type { Metadata } from 'next'
import { Anonymous_Pro, Arimo } from 'next/font/google'
import { ClientProviders } from '@/components/providers/client-providers'
import { AppShell } from '@/components/layout/app-shell'
import './globals.css'

// PRIMARY DISPLAY/BODY — Arimo (open, Google-hosted). Keeps the same
// --font-display variable the design system reads.
const display = Arimo({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  style: ['normal', 'italic'],
  variable: '--font-display',
  display: 'swap',
  fallback: ['system-ui', 'sans-serif'],
})

// PRIMARY MONO — Anonymous Pro (brand tagline + uppercase micro-labels).
const anonymousPro = Anonymous_Pro({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Den',
  description: 'Build, run, and review AI agents connected to your tools.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${anonymousPro.variable}`}>
      <body>
        <ClientProviders>
          <AppShell>{children}</AppShell>
        </ClientProviders>
      </body>
    </html>
  )
}
