import type { Metadata } from 'next'
import localFont from 'next/font/local'
import { Anonymous_Pro } from 'next/font/google'
import { ClientProviders } from '@/components/providers/client-providers'
import { AppShell } from '@/components/layout/app-shell'
import './globals.css'

// PRIMARY DISPLAY/BODY — KMR Waldenburg (proprietary, self-hosted). Arimo is the
// brand's metric-compatible Google alternate and sits in the fallback chain.
const waldenburg = localFont({
  src: [
    { path: '../../public/fonts/kmrwaldenburg-light.ttf', weight: '300', style: 'normal' },
    { path: '../../public/fonts/kmrwaldenburg-regular.ttf', weight: '400', style: 'normal' },
    { path: '../../public/fonts/kmrwaldenburg-italic.ttf', weight: '400', style: 'italic' },
    { path: '../../public/fonts/kmrwaldenburg-medium.ttf', weight: '500', style: 'normal' },
    { path: '../../public/fonts/kmrwaldenburg-bold.ttf', weight: '700', style: 'normal' },
  ],
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
    <html lang="en" className={`${waldenburg.variable} ${anonymousPro.variable}`}>
      <body>
        <ClientProviders>
          <AppShell>{children}</AppShell>
        </ClientProviders>
      </body>
    </html>
  )
}
