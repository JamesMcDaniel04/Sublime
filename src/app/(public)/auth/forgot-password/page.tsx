'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthShell } from '@/components/auth/auth-shell'
import { TurnstileWidget, turnstileEnabled } from '@/components/auth/turnstile-widget'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setLoading(true)
    const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || window.location.origin
    // Always show the same result to avoid disclosing whether an account exists.
    // Password recovery is the classic email-bomb surface: unauthenticated,
    // sends mail on demand, and deliberately reveals nothing about the outcome.
    // The captcha is what stops a script from walking an address list.
    await createClient().auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${origin}/auth/callback?next=/auth/update-password`,
      ...(captchaToken ? { captchaToken } : {}),
    })
    setSent(true)
    setLoading(false)
  }

  return (
    <AuthShell
      eyebrow="Reset password"
      title="Reset your password"
      subtitle="Enter your email and we'll send you a reset link."
    >
      {sent ? (
        <div className="space-y-4">
          <p className="text-[13px] leading-[1.6] text-muted-foreground">
            If an account exists for that email, a reset link is on its way.
          </p>
          <Link
            className="text-[13px] font-medium text-foreground underline underline-offset-4 decoration-foreground/30 transition-colors hover:decoration-foreground"
            href="/auth/login"
          >
            Return to sign in
          </Link>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <TurnstileWidget onToken={setCaptchaToken} />
          <Button
            className="w-full bg-foreground text-background hover:bg-foreground/90"
            type="submit"
            loading={loading}
            disabled={turnstileEnabled() && !captchaToken}
          >
            Send reset link
          </Button>
          <div className="border-t border-border pt-4 text-center">
            <Link
              className="text-[13px] text-muted-foreground underline underline-offset-4 decoration-foreground/30 transition-colors hover:text-foreground hover:decoration-foreground"
              href="/auth/login"
            >
              Back to sign in
            </Link>
          </div>
        </form>
      )}
    </AuthShell>
  )
}
