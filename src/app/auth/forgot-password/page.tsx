'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setLoading(true)
    const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || window.location.origin
    // Always show the same result to avoid disclosing whether an account exists.
    await createClient().auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${origin}/auth/callback?next=/auth/update-password`,
    })
    setSent(true)
    setLoading(false)
  }

  return <div className="flex min-h-screen items-center justify-center bg-gradient-horizon p-4">
    <Card className="w-full max-w-md shadow-3">
      <CardHeader><CardTitle>Reset your password</CardTitle></CardHeader>
      <CardContent>
        {sent ? <div className="space-y-4"><p className="text-sm text-muted-foreground">If an account exists for that email, a reset link is on its way.</p><Link className="text-sm font-medium text-primary hover:underline" href="/auth/login">Return to sign in</Link></div> :
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-2"><Label htmlFor="email">Email</Label><Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <Button className="w-full" type="submit" loading={loading}>Send reset link</Button>
          </form>}
      </CardContent>
    </Card>
  </div>
}
