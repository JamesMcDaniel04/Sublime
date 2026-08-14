'use client'

/**
 * Email, password, MFA and sessions. Fully self-contained: this tab owns the
 * MFA factor fetch (it is the only consumer), so the settings shell no longer
 * needs a Supabase client at all.
 */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type Factor = { id: string; friendly_name?: string; status: string }

/**
 * Render Supabase's TOTP QR as an image rather than injected HTML.
 *
 * `totp.qr_code` is SVG markup from the Supabase API. It was previously passed
 * to dangerouslySetInnerHTML — the only such sink in the codebase. The source
 * is trusted, so this was never an active vulnerability; removing it means the
 * claim "we have zero HTML injection points" is greppable rather than
 * qualified, and an SVG loaded through <img> cannot execute script even if the
 * upstream response were ever attacker-influenced.
 */
function qrSource(qr: string): string {
  return qr.startsWith('data:') ? qr : `data:image/svg+xml;utf8,${encodeURIComponent(qr)}`
}

export function SecurityTab({ initialEmail }: Readonly<{ initialEmail: string }>) {
  const supabase = createClient()
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [factors, setFactors] = useState<Factor[]>([])
  const [enrollment, setEnrollment] = useState<{ id: string; qr: string } | null>(null)
  const [code, setCode] = useState('')

  async function loadFactors() {
    const result = await supabase.auth.mfa.listFactors()
    if (result.error) return toast.error(result.error.message)
    setFactors((result.data?.totp || []) as Factor[])
  }
  useEffect(() => { void loadFactors() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function changeEmail() {
    const { error } = await supabase.auth.updateUser({ email: email.trim().toLowerCase() })
    if (error) toast.error(error.message)
    else toast.success('Check both addresses to confirm the change')
  }
  async function changePassword() {
    if (password.length < 12) return toast.error('Use at least 12 characters')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) return toast.error(error.message)
    await supabase.auth.signOut({ scope: 'others' }); setPassword(''); toast.success('Password updated; other sessions were signed out')
  }
  async function enrollMfa() {
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator app' })
    if (error) return toast.error(error.message)
    setEnrollment({ id: data.id, qr: data.totp.qr_code })
  }
  async function verifyMfa() {
    if (!enrollment) return
    const challenge = await supabase.auth.mfa.challenge({ factorId: enrollment.id })
    if (challenge.error) return toast.error(challenge.error.message)
    const result = await supabase.auth.mfa.verify({ factorId: enrollment.id, challengeId: challenge.data.id, code })
    if (result.error) return toast.error(result.error.message)
    setEnrollment(null); setCode(''); await loadFactors(); toast.success('Two-factor authentication enabled')
  }
  async function removeMfa(id: string) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: id })
    if (error) return toast.error(error.message)
    await loadFactors(); toast.success('Authenticator removed')
  }

  return (
    <>
      <Card className="max-w-2xl"><CardHeader><CardTitle>Email address</CardTitle></CardHeader><CardContent className="flex flex-col gap-3 sm:flex-row"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /><Button onClick={changeEmail}>Change email</Button></CardContent></Card>
      <Card className="max-w-2xl"><CardHeader><CardTitle>Password</CardTitle></CardHeader><CardContent className="flex flex-col gap-3 sm:flex-row"><Input type="password" autoComplete="new-password" placeholder="At least 12 characters" value={password} onChange={(e) => setPassword(e.target.value)} /><Button onClick={changePassword}>Change password</Button></CardContent></Card>
      <Card className="max-w-2xl"><CardHeader><CardTitle>Two-factor authentication</CardTitle></CardHeader><CardContent className="space-y-4">
        {factors.map((factor) => <div key={factor.id} className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{factor.friendly_name || 'Authenticator app'} · {factor.status}</span><Button variant="outline" onClick={() => removeMfa(factor.id)}>Remove</Button></div>)}
        {enrollment ? <div className="space-y-3">{/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="w-48" alt="Two-factor setup QR code" src={qrSource(enrollment.qr)} /><p className="text-sm text-muted-foreground">Scan the code, then enter the six-digit verification code.</p><div className="flex gap-3"><Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /><Button onClick={verifyMfa}>Verify</Button></div></div> : <Button variant="outline" onClick={enrollMfa}>Add authenticator</Button>}
      </CardContent></Card>
      <Card className="max-w-2xl"><CardHeader><CardTitle>Sessions</CardTitle></CardHeader><CardContent><Button variant="outline" onClick={async () => { const { error } = await supabase.auth.signOut({ scope: 'others' }); if (error) toast.error(error.message); else toast.success('Other sessions signed out') }}>Sign out other sessions</Button></CardContent></Card>
    </>
  )
}
