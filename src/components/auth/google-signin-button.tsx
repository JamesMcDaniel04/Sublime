'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

/** "Continue with Google" via Supabase OAuth. The provider must be enabled in
 * the Supabase dashboard. `returnTo` survives the OAuth round-trip through the
 * /auth/callback `next` param (sanitized server-side by safeReturnToPath). */
export function GoogleSignInButton({ returnTo = '/dashboard' }: { returnTo?: string }) {
  const [loading, setLoading] = useState(false)

  const handleClick = async () => {
    setLoading(true)
    // The callback MUST return to the exact origin the user is on: the PKCE
    // code-verifier cookie is host-scoped, so an env-configured origin (apex
    // vs www, stale domain, preview URL) would strand the verifier on this
    // host while the code lands on another — every exchange would then fail
    // with "invalid or expired". window.location.origin is correct by
    // construction; the only dashboard requirement is that each app origin's
    // /auth/callback is in Supabase's redirect allow-list.
    const callback = `${window.location.origin}/auth/callback?next=${encodeURIComponent(returnTo)}`
    const { error } = await createClient().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callback },
    })
    if (error) {
      toast.error(error.message)
      setLoading(false)
    }
    // On success the browser navigates away; leave the spinner running.
  }

  return (
    <Button type="button" variant="outline" className="w-full" loading={loading} onClick={handleClick}>
      <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden>
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.27-4.74 3.27-8.09z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
        <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z" />
        <path fill="#EA4335" d="M12 5.36c1.62 0 3.06.56 4.21 1.66l3.15-3.15A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.29 9.14 5.36 12 5.36z" />
      </svg>
      Continue with Google
    </Button>
  )
}
