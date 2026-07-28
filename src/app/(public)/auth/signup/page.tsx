'use client'

import { useState } from 'react'
import { useSupabase } from '@/components/providers/supabase-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthShell } from '@/components/auth/auth-shell'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { safeReturnToPath } from '@/lib/auth/redirect'
import { GoogleSignInButton } from '@/components/auth/google-signin-button'

export default function SignUpPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  
  const { signUp } = useSupabase()
  const router = useRouter()
  // Carries a destination (e.g. a plan checkout) through signup: into the
  // confirmation email link, the Google OAuth round-trip, and the login link.
  const returnTo = typeof window === 'undefined' ? '/dashboard' : safeReturnToPath(new URLSearchParams(window.location.search).get('return_to'))

  const handleEmailSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setSuccess('')

    if (password !== confirmPassword) {
      const errorMessage = 'Passwords do not match'
      setError(errorMessage)
      toast.error(errorMessage)
      setLoading(false)
      return
    }

    try {
      // Include organization data in user metadata
      const { data, error } = await signUp(email, password, {
        data: {
          first_name: firstName,
          last_name: lastName,
          full_name: `${firstName} ${lastName}`.trim()
        },
        next: returnTo,
      })
      
      if (error) {
        setError(error.message)
        toast.error(error.message)
      } else if (data?.user) {
        const successMessage = 'Check your email for the confirmation link!'
        setSuccess(successMessage)
        toast.success(successMessage)
        
        // Optionally redirect to login after a delay
        setTimeout(() => {
          router.push('/auth/login')
        }, 3000)
      }
    } catch (err: any) {
      const errorMessage = err.message || 'An unexpected error occurred'
      setError(errorMessage)
      toast.error(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      eyebrow="Get started"
      title="Create your account"
      subtitle="Create your workspace and set your first goal in minutes. Cancel anytime."
    >
      <div className="space-y-4">
            {error && (
              <div className="border border-destructive/40 bg-destructive/10 p-3 text-[13px] text-destructive">
                {error}
              </div>
            )}

            {success && (
              <div className="border border-success/40 bg-success/10 p-3 text-[13px] text-foreground">
                {success}
              </div>
            )}

            <GoogleSignInButton returnTo={returnTo} />
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <form onSubmit={handleEmailSignUp} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First name</Label>
                  <Input
                    id="firstName"
                    type="text"
                    placeholder="John"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last name</Label>
                  <Input
                    id="lastName"
                    type="text"
                    placeholder="Doe"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="At least 12 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={12}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="Repeat the 12-character password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={12}
                />
              </div>
              <Button type="submit" className="w-full bg-foreground text-background hover:bg-foreground/90" loading={loading}>
                {loading ? 'Creating account…' : 'Create account'}
              </Button>
            </form>

            <div className="border-t border-border pt-4 text-center">
              <p className="text-[13px] text-muted-foreground">
                Already have an account?{' '}
                <Link href={`/auth/login?return_to=${encodeURIComponent(returnTo)}`} className="font-medium text-foreground underline underline-offset-4 decoration-foreground/30 transition-colors hover:decoration-foreground">
                  Sign in
                </Link>
              </p>
            </div>
      </div>
    </AuthShell>
  )
}
