'use client'

import { useState, useEffect } from 'react'
import { useSupabase } from '@/components/providers/supabase-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import Link from 'next/link'
import { toast } from 'sonner'
import { safeReturnToPath } from '@/lib/auth/redirect'
import { ensureWorkspaceReady } from '@/lib/auth/workspace'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mfa, setMfa] = useState<{ factorId: string; challengeId: string } | null>(null)
  const [mfaCode, setMfaCode] = useState('')
  
  const { signIn, loading: authLoading } = useSupabase()
  const returnTo = typeof window === 'undefined' ? '/dashboard' : safeReturnToPath(new URLSearchParams(window.location.search).get('return_to'))

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
    
  }, [])

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
        await ensureWorkspaceReady()
        // Force a page refresh after provisioning so server components observe
        // both the new session and its application membership.
        window.location.href = returnTo
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
    try {
      const { error } = await createClient().auth.mfa.verify({ factorId: mfa.factorId, challengeId: mfa.challengeId, code: mfaCode })
      if (error) { setError('Invalid or expired verification code.'); return }
      await ensureWorkspaceReady()
      window.location.href = returnTo
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not finish setting up your workspace.')
    } finally {
      setLoading(false)
    }
  }

  // Show loading spinner while checking auth state
  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-horizon p-4">
        <div className="flex items-center gap-2 text-white">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-white motion-reduce:animate-none" />
          <span>Loading…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-horizon p-4">
      <div className="w-full max-w-md animate-fade-in-up">
        <div className="mb-8 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/sublime-logo-white.svg" alt="Sublime" className="mx-auto mb-6 h-7" />
          <h1 className="text-2xl font-semibold text-white">Welcome back</h1>
          <p className="mt-1 text-white/70">Sign in to your Sublime workspace.</p>
        </div>

        <Card className="shadow-3">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Enter your credentials to access your workspace.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && (
              <div className="animate-fade-in rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {mfa ? <form onSubmit={verifyMfa} className="space-y-4">
              <div className="space-y-2"><Label htmlFor="mfaCode">Authentication code</Label><Input id="mfaCode" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))} required /></div>
              <Button type="submit" className="w-full" loading={loading}>Verify</Button>
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
              <Button type="submit" className="w-full" loading={loading}>
                {loading ? 'Signing in…' : 'Sign in'}
              </Button>
              <div className="text-right">
                <Link href="/auth/forgot-password" className="text-sm font-medium text-primary hover:underline">
                  Forgot password?
                </Link>
              </div>
            </form>}

            <div className="text-center">
              <p className="text-sm text-muted-foreground">
                Don&apos;t have an account?{' '}
                <Link href="/auth/signup" className="font-medium text-primary hover:underline">
                  Sign up
                </Link>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
