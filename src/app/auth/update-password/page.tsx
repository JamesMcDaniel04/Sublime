'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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

  return <div className="flex min-h-screen items-center justify-center bg-gradient-horizon p-4"><Card className="w-full max-w-md shadow-3">
    <CardHeader><CardTitle>Choose a new password</CardTitle></CardHeader><CardContent><form className="space-y-4" onSubmit={submit}>
      {message && <p role="alert" className="text-sm text-muted-foreground">{message}</p>}
      <div className="space-y-2"><Label htmlFor="password">New password</Label><Input id="password" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="confirm">Confirm password</Label><Input id="confirm" type="password" autoComplete="new-password" minLength={12} required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
      <Button className="w-full" type="submit" loading={loading}>Update password</Button>
    </form></CardContent>
  </Card></div>
}
