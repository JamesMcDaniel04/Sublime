'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthShell } from '@/components/auth/auth-shell'

export default function UpdatePasswordPage() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (password !== confirm) return setMessage('Passwords do not match.')
    if (password.length < 12) return setMessage('Use at least 12 characters.')
    setLoading(true)
    const { error } = await createClient().auth.updateUser({ password })
    setLoading(false)
    if (error) return setMessage('This reset link is invalid or expired. Request a new one.')
    await createClient().auth.signOut({ scope: 'others' })
    window.location.replace('/dashboard?password=updated')
  }

  return (
    <AuthShell
      eyebrow="Reset password"
      title="Choose a new password"
      subtitle="Use at least 12 characters. Other sessions are signed out after the change."
    >
      <form className="space-y-4" onSubmit={submit}>
        {message && (
          <p role="alert" className="border border-destructive/40 bg-destructive/10 p-3 text-[13px] text-destructive">
            {message}
          </p>
        )}
        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
          <Input id="password" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input id="confirm" type="password" autoComplete="new-password" minLength={12} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button className="w-full bg-foreground text-background hover:bg-foreground/90" type="submit" loading={loading}>
          Update password
        </Button>
      </form>
    </AuthShell>
  )
}
