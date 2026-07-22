'use client'

import { useState, useEffect } from 'react'
import { useSupabase } from '@/components/providers/supabase-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthShell } from '@/components/auth/auth-shell'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { safeReturnToPath } from '@/lib/auth/redirect'
import { createClient } from '@/lib/supabase/client'
import { GoogleSignInButton } from '@/components/auth/google-signin-button'
import { primeBootstrap } from '@/lib/client/snapshot'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mfa, setMfa] = useState<{ factorId: string; challengeId: string } | null>(null)
  const [mfaCode, setMfaCode] = useState('')
  
  const { signIn, user, loading: authLoading } = useSupabase()
  const router = useRouter()
  const returnTo = typeof window === 'undefined' ? '/dashboard' : safeReturnToPath(new URLSearchParams(window.location.search).get('return_to'))

  const finishLogin = async (userId: string) => {
    // Persist the scoped shell model before the intentional hard navigation.
    // A short ceiling keeps a degraded backend from trapping the login form.
    await Promise.race([
      primeBootstrap(userId),
      new Promise((resolve) => window.setTimeout(resolve, 3_500)),
    ]).catch(() => undefined)
    window.location.href = returnTo
  }

  // Handle Supabase email verification redirected to wrong URL
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search)
      const tokenHash = urlParams.get('token_hash')
      const type = urlParams.get('type')
      
      // If this is a Supabase email verification that was redirected to login page, redirect to callback
      if (tokenHash && type) {
        const callbackUrl = new URL('/auth/callback', window.location.origin)
        callbackUrl.searchParams.set('token_hash', tokenHash)
        callbackUrl.searchParams.set('type', type)
        
        // Preserve any other parameters
        const returnTo = urlParams.get('return_to')
        if (returnTo) {
          callbackUrl.searchParams.set('next', returnTo)
        }
        
        window.location.href = callbackUrl.toString()
        return
      }
    }
    
    // Redirect if already authenticated
    if (!authLoading && user && !loading && !mfa) {
      router.push('/dashboard')
    }
  }, [user, authLoading, loading, mfa, router])

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const { data, error } = await signIn(email, password)
      
      if (error) {
        setError(error.message)
        toast.error(error.message)
      } else if (data?.user) {
        const supabase = createClient()
        const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
        if (assurance.data?.nextLevel === 'aal2' && assurance.data.currentLevel !== 'aal2') {
          const factors = await supabase.auth.mfa.listFactors()
          const factor = factors.data?.totp.find((candidate) => candidate.status === 'verified')
          if (!factor) throw new Error('Two-factor authentication is required but no verified factor is available.')
          const challenge = await supabase.auth.mfa.challenge({ factorId: factor.id })
          if (challenge.error) throw challenge.error
          setMfa({ factorId: factor.id, challengeId: challenge.data.id })
          return
        }
        // Force page refresh after successful login to ensure auth state is properly updated.
        await finishLogin(data.user.id)
      }
    } catch (err: any) {
      const errorMessage = err.message || 'An unexpected error occurred'
      setError(errorMessage)
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const verifyMfa = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!mfa) return
    setLoading(true); setError('')
    const { error } = await createClient().auth.mfa.verify({ factorId: mfa.factorId, challengeId: mfa.challengeId, code: mfaCode })
    setLoading(false)
    if (error) { setError('Invalid or expired verification code.'); return }
    if (user?.id) await finishLogin(user.id)
    else window.location.href = returnTo
  }

  // Show loading spinner while checking auth state
  if (authLoading) {
    return (
      <div className="lovable-landing dark flex min-h-screen items-center justify-center bg-background p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-foreground motion-reduce:animate-none" />
          <span className="text-sm">Loading…</span>
        </div>
      </div>
    )
  }

  return (
    <AuthShell
      eyebrow="Welcome back"
      title={mfa ? 'Two-factor check' : 'Sign in to Sublime'}
      subtitle={mfa ? 'Enter the 6-digit code from your authenticator app.' : 'Enter your credentials to access your workspace.'}
    >
      <div className="space-y-4">
            {error && (
              <div className="border border-destructive/40 bg-destructive/10 p-3 text-[13px] text-destructive">
                {error}
              </div>
            )}

            {!mfa && (
              <>
                <GoogleSignInButton returnTo={returnTo} />
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">or</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
              </>
            )}

            {mfa ? <form onSubmit={verifyMfa} className="space-y-4">
              <div className="space-y-2"><Label htmlFor="mfaCode">Authentication code</Label><Input id="mfaCode" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))} required /></div>
              <Button type="submit" className="w-full bg-foreground text-background hover:bg-foreground/90" loading={loading}>Verify</Button>
            </form> : <form onSubmit={handleEmailLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  aria-invalid={Boolean(error)}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full bg-foreground text-background hover:bg-foreground/90" loading={loading}>
                {loading ? 'Signing in…' : 'Sign in'}
              </Button>
              <div className="text-right">
                <Link href="/auth/forgot-password" className="text-[13px] text-muted-foreground underline underline-offset-4 decoration-foreground/30 transition-colors hover:text-foreground hover:decoration-foreground">
                  Forgot password?
                </Link>
              </div>
            </form>}

            <div className="border-t border-border pt-4 text-center">
              <p className="text-[13px] text-muted-foreground">
                Don&apos;t have an account?{' '}
                <Link href={`/auth/signup?return_to=${encodeURIComponent(returnTo)}`} className="font-medium text-foreground underline underline-offset-4 decoration-foreground/30 transition-colors hover:decoration-foreground">
                  Sign up
                </Link>
              </p>
            </div>
      </div>
    </AuthShell>
  )
}
