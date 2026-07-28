import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LandingPage } from '@/components/landing/landing-page'
import './landing.css'

// Self-hosted via next/font: a Google Fonts CSS import would be blocked by the
// deployment's style-src CSP and silently fall back to system fonts.
const geist = Geist({ subsets: ['latin'], display: 'swap' })

// Rendered per-request: the try/catch around the Supabase auth check would
// otherwise swallow the dynamic-usage signal and bake a static page at build.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  metadataBase: new URL('https://trysublime.io'),
  title: 'Sublime — AI that proves its ROI',
  description:
    'Sublime is the goal-based AI platform. It connects to your tech stack, connects the dots, and deploys specialized agents that automate repetitive work, cut costs, and find process wins — measured against the goals your org runs on.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Sublime — AI that proves its ROI',
    description:
      'The goal-based AI platform: connect your stack, and Sublime deploys specialized agents measured against the goals your org runs on.',
    url: 'https://trysublime.io',
    siteName: 'Sublime',
    type: 'website',
  },
}

export default async function Home() {
  // Signed-in visitors go straight to the app; everyone else sees the landing.
  // If Supabase isn't configured, the public page still renders.
  let user = null
  try {
    const supabase = await createClient()
    user = (await supabase.auth.getUser()).data.user
  } catch {
    user = null
  }
  if (user) redirect('/dashboard')

  return <LandingPage fontClassName={geist.className} />
}
