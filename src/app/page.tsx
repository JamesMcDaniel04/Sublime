import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LandingPage } from '@/components/landing/landing-page'
import './landing.css'

// Rendered per-request: the try/catch around the Supabase auth check would
// otherwise swallow the dynamic-usage signal and bake a static page at build.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  metadataBase: new URL('https://trysublime.io'),
  title: 'Sublime — AI that knows your business',
  description:
    'Connect the tools your team already uses. Sublime reconstructs how work gets done, then powers agents and workflows that deliver useful outcomes from day one.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Sublime — AI that knows your business',
    description:
      'Connect the tools your team already uses. Sublime powers agents and workflows that deliver useful outcomes from day one.',
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

  return <LandingPage />
}
