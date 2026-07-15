'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'
import { LearningsPanel } from './learnings-panel'

type Profile = { name: string; email: string; imageUrl: string | null; role: string }
type Factor = { id: string; friendly_name?: string; status: string }
type Member = { id: string; email: string | null; name: string | null; role: 'ADMIN' | 'USER'; isActive: boolean }
type Invitation = { id: string; email: string; role: 'ADMIN' | 'USER'; expiresAt: string; createdAt: string }
type OrgSettings = { disableConnectionScans?: boolean }

export default function SettingsPage() {
  const supabase = createClient()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [factors, setFactors] = useState<Factor[]>([])
  const [enrollment, setEnrollment] = useState<{ id: string; qr: string } | null>(null)
  const [code, setCode] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [orgSettings, setOrgSettings] = useState<OrgSettings>({})
  const [savingScanToggle, setSavingScanToggle] = useState(false)

  async function load() {
    const [response, factorResult, memberResponse, orgResponse] = await Promise.all([
      fetch('/api/settings/profile', { cache: 'no-store' }),
      supabase.auth.mfa.listFactors(),
      fetch('/api/settings/members', { cache: 'no-store' }),
      fetch('/api/organizations', { cache: 'no-store' }),
    ])
    const data = await response.json()
    if (data.success) { setProfile(data.profile); setEmail(data.profile.email || '') }
    setFactors((factorResult.data?.totp || []) as Factor[])
    const memberData = await memberResponse.json(); if (memberData.success) { setMembers(memberData.members); setInvitations(memberData.invitations || []) }
    const orgData = await orgResponse.json()
    if (orgData.success) setOrgSettings((orgData.organizations?.[0]?.settings || {}) as OrgSettings)
  }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleConnectionScanning(enabled: boolean) {
    setSavingScanToggle(true)
    try {
      const response = await fetch('/api/organizations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { disableConnectionScans: !enabled } }),
      })
      const data = await response.json()
      if (!response.ok) { toast.error(data.error || 'Could not update setting'); return }
      setOrgSettings((data.organization?.settings || {}) as OrgSettings)
      toast.success(enabled ? 'Connection scanning enabled' : 'Connection scanning disabled')
    } finally {
      setSavingScanToggle(false)
    }
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault()
    const response = await fetch('/api/settings/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) })
    const data = await response.json()
    if (!response.ok) return toast.error(data.error || 'Could not save profile')
    setProfile(data.profile); toast.success('Profile saved')
  }

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
    setEnrollment(null); setCode(''); await load(); toast.success('Two-factor authentication enabled')
  }
  async function removeMfa(id: string) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: id })
    if (error) return toast.error(error.message)
    await load(); toast.success('Authenticator removed')
  }
  async function inviteMember(event: React.FormEvent) {
    event.preventDefault()
    const response = await fetch('/api/settings/members', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: inviteEmail, role: 'USER' }) })
    const data = await response.json(); if (!response.ok) return toast.error(data.error || 'Could not send invitation')
    setInviteEmail(''); await load(); toast.success('Invitation sent')
  }
  async function updateMember(member: Member, changes: Partial<Member>) {
    const response = await fetch('/api/settings/members', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: member.id, ...changes }) })
    const data = await response.json(); if (!response.ok) return toast.error(data.error || 'Could not update member')
    await load(); toast.success('Member updated')
  }
  async function revokeInvitation(invitation: Invitation) {
    const response = await fetch(`/api/settings/members?invitationId=${encodeURIComponent(invitation.id)}`, { method: 'DELETE' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) return toast.error(data.error || 'Could not revoke invitation')
    setInvitations((current) => current.filter((entry) => entry.id !== invitation.id))
    toast.success('Invitation revoked')
  }

  return <div className="space-y-6"><PageHeader eyebrow="Account" title="Settings" description="Manage your profile, sign-in security, and active sessions." />
    <Tabs defaultValue="profile"><TabsList><TabsTrigger value="profile">Profile</TabsTrigger><TabsTrigger value="security">Security</TabsTrigger><TabsTrigger value="members">Members</TabsTrigger><TabsTrigger value="workspace">Workspace</TabsTrigger></TabsList>
      <TabsContent value="profile" className="mt-6">{profile && <Card className="max-w-2xl"><CardHeader><CardTitle>Profile</CardTitle></CardHeader><CardContent><form className="space-y-4" onSubmit={saveProfile}>
        <div className="space-y-2"><Label htmlFor="name">Display name</Label><Input id="name" value={profile.name || ''} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></div>
        <Button type="submit">Save profile</Button>
      </form></CardContent></Card>}
        <Card className="mt-6 max-w-2xl border-red-200"><CardHeader><CardTitle>Delete account</CardTitle></CardHeader><CardContent><p className="mb-4 text-sm text-muted-foreground">Permanently removes your account. If you are the only member, the workspace and its data are also deleted.</p><Button variant="outline" onClick={async () => { if (window.prompt('Type DELETE to permanently delete your account') !== 'DELETE') return; const response = await fetch('/api/settings/profile', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'DELETE' }) }); const data = await response.json(); if (!response.ok) return toast.error(data.error || 'Could not delete account'); await supabase.auth.signOut(); window.location.replace('/') }}>Delete account</Button></CardContent></Card>
      </TabsContent>
      <TabsContent value="security" className="mt-6 space-y-6">
        <Card className="max-w-2xl"><CardHeader><CardTitle>Email address</CardTitle></CardHeader><CardContent className="flex gap-3"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /><Button onClick={changeEmail}>Change email</Button></CardContent></Card>
        <Card className="max-w-2xl"><CardHeader><CardTitle>Password</CardTitle></CardHeader><CardContent className="flex gap-3"><Input type="password" autoComplete="new-password" placeholder="At least 12 characters" value={password} onChange={(e) => setPassword(e.target.value)} /><Button onClick={changePassword}>Change password</Button></CardContent></Card>
        <Card className="max-w-2xl"><CardHeader><CardTitle>Two-factor authentication</CardTitle></CardHeader><CardContent className="space-y-4">
          {factors.map((factor) => <div key={factor.id} className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{factor.friendly_name || 'Authenticator app'} · {factor.status}</span><Button variant="outline" onClick={() => removeMfa(factor.id)}>Remove</Button></div>)}
          {enrollment ? <div className="space-y-3"><div className="w-48" dangerouslySetInnerHTML={{ __html: enrollment.qr }} /><p className="text-sm text-muted-foreground">Scan the code, then enter the six-digit verification code.</p><div className="flex gap-3"><Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /><Button onClick={verifyMfa}>Verify</Button></div></div> : <Button variant="outline" onClick={enrollMfa}>Add authenticator</Button>}
        </CardContent></Card>
        <Card className="max-w-2xl"><CardHeader><CardTitle>Sessions</CardTitle></CardHeader><CardContent><Button variant="outline" onClick={async () => { const { error } = await supabase.auth.signOut({ scope: 'others' }); if (error) toast.error(error.message); else toast.success('Other sessions signed out') }}>Sign out other sessions</Button></CardContent></Card>
      </TabsContent>
      <TabsContent value="members" className="mt-6"><Card className="max-w-3xl"><CardHeader><CardTitle>Workspace members</CardTitle></CardHeader><CardContent className="space-y-4">
        <form className="flex gap-3" onSubmit={inviteMember}><Input type="email" placeholder="colleague@example.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required /><Button type="submit">Invite</Button></form>
        {invitations.length > 0 && <div className="space-y-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pending invitations</p>{invitations.map((invitation) => <div key={invitation.id} className="flex items-center gap-3 rounded-md border border-dashed p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{invitation.email}</p><p className="text-xs text-muted-foreground">{invitation.role} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</p></div><Button variant="outline" size="sm" onClick={() => revokeInvitation(invitation)}>Revoke</Button></div>)}</div>}
        {members.map((member) => <div key={member.id} className="flex items-center gap-3 rounded-md border p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{member.name || member.email}</p><p className="truncate text-xs text-muted-foreground">{member.email}</p></div><Button variant="outline" onClick={() => updateMember(member, { role: member.role === 'ADMIN' ? 'USER' : 'ADMIN' })}>{member.role}</Button><Button variant="outline" onClick={() => updateMember(member, { isActive: !member.isActive })}>{member.isActive ? 'Suspend' : 'Reactivate'}</Button></div>)}
      </CardContent></Card></TabsContent>
      <TabsContent value="workspace" className="mt-6">
        <Card className="max-w-2xl">
          <CardHeader><CardTitle>Connection scanning</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Learn from connected tools</p>
                <p className="text-sm text-muted-foreground">When you connect a tool, Sublime samples recent usage (read-only) to learn how your team works. Learning happens automatically — no migrations required.</p>
              </div>
              <Switch
                checked={orgSettings.disableConnectionScans !== true}
                disabled={savingScanToggle || profile?.role !== 'ADMIN'}
                onCheckedChange={toggleConnectionScanning}
              />
            </div>
            {profile && profile.role !== 'ADMIN' && (
              <p className="mt-3 text-xs text-muted-foreground">Only workspace admins can change this setting.</p>
            )}
          </CardContent>
        </Card>
        <LearningsPanel />
      </TabsContent>
    </Tabs>
  </div>
}
