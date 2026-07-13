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

type Role = 'ADMIN' | 'USER'
type Profile = {
  id: string
  name: string
  email: string
  imageUrl: string | null
  timezone: string
  role: Role
}
type Factor = { id: string; friendly_name?: string; status: string }
type Member = {
  id: string
  email: string | null
  name: string | null
  role: Role
  isActive: boolean
  lastSeenAt: string | null
}
type Invitation = {
  id: string
  email: string
  role: Role
  expiresAt: string
  createdAt: string
}
type Organization = {
  id: string
  name: string
  settings: { disableConnectionScans?: boolean }
}

const roleSelectClass =
  'h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

async function responseData(response: Response): Promise<Record<string, any>> {
  return response.json().catch(() => ({}))
}

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
  const [inviteRole, setInviteRole] = useState<Role>('USER')
  const [organization, setOrganization] = useState<Organization | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const isAdmin = profile?.role === 'ADMIN'

  async function load() {
    const [profileResponse, factorResult] = await Promise.all([
      fetch('/api/settings/profile', { cache: 'no-store' }),
      supabase.auth.mfa.listFactors(),
    ])

    const profileData = await responseData(profileResponse)
    if (profileResponse.ok && profileData.success) {
      setProfile(profileData.profile)
      setEmail(profileData.profile.email || '')
      if (profileData.profile.role === 'ADMIN') {
        const [memberResponse, orgResponse] = await Promise.all([
          fetch('/api/settings/members', { cache: 'no-store' }),
          fetch('/api/organizations', { cache: 'no-store' }),
        ])
        const memberData = await responseData(memberResponse)
        if (memberResponse.ok && memberData.success) {
          setMembers(memberData.members || [])
          setInvitations(memberData.invitations || [])
        } else {
          toast.error(memberData.error || 'Could not load workspace members')
        }
        const orgData = await responseData(orgResponse)
        if (orgResponse.ok && orgData.success) {
          setOrganization(orgData.organizations?.[0] || null)
        } else {
          toast.error(orgData.error || 'Could not load workspace settings')
        }
      } else {
        setMembers([])
        setInvitations([])
        setOrganization(null)
      }
    } else {
      toast.error(profileData.error || 'Could not load profile settings')
    }

    if (factorResult.error) toast.error(factorResult.error.message)
    else setFactors((factorResult.data?.totp || []) as Factor[])

  }

  useEffect(() => {
    void load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function runAction(key: string, action: () => Promise<unknown>) {
    setBusyAction(key)
    try {
      await action()
    } catch {
      toast.error('The request could not be completed. Please try again.')
    } finally {
      setBusyAction(null)
    }
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault()
    if (!profile) return
    await runAction('profile', async () => {
      const response = await fetch('/api/settings/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: profile.name,
          timezone: profile.timezone,
          imageUrl: profile.imageUrl || null,
        }),
      })
      const data = await responseData(response)
      if (!response.ok) return toast.error(data.error || 'Could not save profile')
      setProfile(data.profile)
      toast.success('Profile saved')
    })
  }

  async function changeEmail() {
    const nextEmail = email.trim().toLowerCase()
    if (!nextEmail || nextEmail === profile?.email?.toLowerCase()) return
    await runAction('email', async () => {
      const { error } = await supabase.auth.updateUser({ email: nextEmail })
      if (error) return toast.error(error.message)
      toast.success('Check both addresses to confirm the change')
    })
  }

  async function changePassword() {
    if (password.length < 12) return toast.error('Use at least 12 characters')
    await runAction('password', async () => {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) return toast.error(error.message)
      const signOut = await supabase.auth.signOut({ scope: 'others' })
      if (signOut.error) return toast.error(signOut.error.message)
      setPassword('')
      toast.success('Password updated; other sessions were signed out')
    })
  }

  async function enrollMfa() {
    await runAction('mfa-enroll', async () => {
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Authenticator app',
      })
      if (error) return toast.error(error.message)
      setEnrollment({ id: data.id, qr: data.totp.qr_code })
    })
  }

  async function verifyMfa() {
    if (!enrollment) return
    await runAction('mfa-verify', async () => {
      const challenge = await supabase.auth.mfa.challenge({ factorId: enrollment.id })
      if (challenge.error) return toast.error(challenge.error.message)
      const result = await supabase.auth.mfa.verify({
        factorId: enrollment.id,
        challengeId: challenge.data.id,
        code,
      })
      if (result.error) return toast.error(result.error.message)
      setEnrollment(null)
      setCode('')
      await load()
      toast.success('Two-factor authentication enabled')
    })
  }

  async function removeMfa(id: string, message = 'Authenticator removed') {
    await runAction(`mfa-${id}`, async () => {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: id })
      if (error) return toast.error(error.message)
      if (enrollment?.id === id) {
        setEnrollment(null)
        setCode('')
      }
      await load()
      toast.success(message)
    })
  }

  async function inviteMember(event: React.FormEvent) {
    event.preventDefault()
    await runAction('invite', async () => {
      const response = await fetch('/api/settings/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      })
      const data = await responseData(response)
      if (!response.ok) return toast.error(data.error || 'Could not send invitation')
      setInviteEmail('')
      setInviteRole('USER')
      await load()
      toast.success(data.resent ? 'Invitation resent' : 'Invitation sent')
    })
  }

  async function resendInvitation(invitation: Invitation) {
    await runAction(`invite-${invitation.id}`, async () => {
      const response = await fetch('/api/settings/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: invitation.email, role: invitation.role }),
      })
      const data = await responseData(response)
      if (!response.ok) return toast.error(data.error || 'Could not resend invitation')
      await load()
      toast.success('Invitation resent')
    })
  }

  async function updateInvitation(invitation: Invitation, role: Role) {
    await runAction(`invite-${invitation.id}`, async () => {
      const response = await fetch('/api/settings/members', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitationId: invitation.id, role }),
      })
      const data = await responseData(response)
      if (!response.ok) return toast.error(data.error || 'Could not update invitation')
      await load()
      toast.success('Invitation updated')
    })
  }

  async function revokeInvitation(invitation: Invitation) {
    await runAction(`invite-${invitation.id}`, async () => {
      const response = await fetch(
        `/api/settings/members?invitationId=${encodeURIComponent(invitation.id)}`,
        { method: 'DELETE' },
      )
      const data = await responseData(response)
      if (!response.ok) return toast.error(data.error || 'Could not revoke invitation')
      await load()
      toast.success('Invitation revoked')
    })
  }

  async function updateMember(member: Member, changes: Partial<Pick<Member, 'role' | 'isActive'>>) {
    await runAction(`member-${member.id}`, async () => {
      const response = await fetch('/api/settings/members', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: member.id, ...changes }),
      })
      const data = await responseData(response)
      if (!response.ok) return toast.error(data.error || 'Could not update member')
      await load()
      toast.success('Member updated')
    })
  }

  async function removeMember(member: Member) {
    if (window.prompt(`Type REMOVE to remove ${member.email || member.name || 'this member'}`) !== 'REMOVE') return
    await runAction(`member-${member.id}`, async () => {
      const response = await fetch(
        `/api/settings/members?memberId=${encodeURIComponent(member.id)}`,
        { method: 'DELETE' },
      )
      const data = await responseData(response)
      if (!response.ok) return toast.error(data.error || 'Could not remove member')
      await load()
      toast.success('Member removed')
    })
  }

  async function saveWorkspace(event: React.FormEvent) {
    event.preventDefault()
    if (!organization) return
    await runAction('workspace', async () => {
      const response = await fetch('/api/organizations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: organization.name }),
      })
      const data = await responseData(response)
      if (!response.ok) return toast.error(data.error || 'Could not update workspace')
      setOrganization(data.organization)
      toast.success('Workspace updated')
    })
  }

  async function toggleConnectionScanning(enabled: boolean) {
    if (!organization) return
    await runAction('scanning', async () => {
      const response = await fetch('/api/organizations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { disableConnectionScans: !enabled } }),
      })
      const data = await responseData(response)
      if (!response.ok) return toast.error(data.error || 'Could not update setting')
      setOrganization(data.organization)
      toast.success(enabled ? 'Connection scanning enabled' : 'Connection scanning disabled')
    })
  }

  async function deleteAccount() {
    if (window.prompt('Type DELETE to permanently delete your account') !== 'DELETE') return
    await runAction('delete-account', async () => {
      const response = await fetch('/api/settings/profile', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'DELETE' }),
      })
      const data = await responseData(response)
      if (!response.ok) return toast.error(data.error || 'Could not delete account')
      await supabase.auth.signOut()
      window.location.replace('/')
    })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description={isAdmin ? 'Manage your account and workspace administration.' : 'Manage your personal profile and sign-in security.'}
      />
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          {isAdmin && <TabsTrigger value="members">Members</TabsTrigger>}
          {isAdmin && <TabsTrigger value="workspace">Workspace</TabsTrigger>}
        </TabsList>

        <TabsContent value="profile" className="mt-6 space-y-6">
          {profile && (
            <Card className="max-w-2xl">
              <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={saveProfile}>
                  <div className="space-y-2">
                    <Label htmlFor="name">Display name</Label>
                    <Input id="name" value={profile.name || ''} onChange={(event) => setProfile({ ...profile, name: event.target.value })} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="timezone">Timezone</Label>
                    <Input id="timezone" placeholder="America/Denver" value={profile.timezone} onChange={(event) => setProfile({ ...profile, timezone: event.target.value })} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="image-url">Profile image URL</Label>
                    <div className="flex gap-3">
                      <Input id="image-url" type="url" placeholder="https://…" value={profile.imageUrl || ''} onChange={(event) => setProfile({ ...profile, imageUrl: event.target.value || null })} />
                      {profile.imageUrl && <Button type="button" variant="outline" onClick={() => setProfile({ ...profile, imageUrl: null })}>Clear</Button>}
                    </div>
                  </div>
                  <Button type="submit" loading={busyAction === 'profile'}>Save profile</Button>
                </form>
              </CardContent>
            </Card>
          )}
          <Card className="max-w-2xl border-red-200">
            <CardHeader><CardTitle>Delete account</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-4 text-sm text-muted-foreground">Permanently removes your account. If you are the only member, the workspace and its data are also deleted.</p>
              <Button variant="destructive" loading={busyAction === 'delete-account'} onClick={deleteAccount}>Delete account</Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security" className="mt-6 space-y-6">
          <Card className="max-w-2xl">
            <CardHeader><CardTitle>Email address</CardTitle></CardHeader>
            <CardContent className="flex gap-3">
              <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
              <Button loading={busyAction === 'email'} disabled={!email.trim() || email.trim().toLowerCase() === profile?.email?.toLowerCase()} onClick={changeEmail}>Change email</Button>
            </CardContent>
          </Card>
          <Card className="max-w-2xl">
            <CardHeader><CardTitle>Password</CardTitle></CardHeader>
            <CardContent className="flex gap-3">
              <Input type="password" autoComplete="new-password" placeholder="At least 12 characters" value={password} onChange={(event) => setPassword(event.target.value)} />
              <Button loading={busyAction === 'password'} onClick={changePassword}>Change password</Button>
            </CardContent>
          </Card>
          <Card className="max-w-2xl">
            <CardHeader><CardTitle>Two-factor authentication</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {factors.map((factor) => (
                <div key={factor.id} className="flex items-center justify-between rounded-md border p-3">
                  <span className="text-sm">{factor.friendly_name || 'Authenticator app'} · {factor.status}</span>
                  <Button variant="outline" loading={busyAction === `mfa-${factor.id}`} onClick={() => removeMfa(factor.id)}>Remove</Button>
                </div>
              ))}
              {enrollment ? (
                <div className="space-y-3">
                  <div className="w-48" dangerouslySetInnerHTML={{ __html: enrollment.qr }} />
                  <p className="text-sm text-muted-foreground">Scan the code, then enter the six-digit verification code.</p>
                  <div className="flex gap-3">
                    <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
                    <Button loading={busyAction === 'mfa-verify'} disabled={code.length !== 6} onClick={verifyMfa}>Verify</Button>
                    <Button variant="outline" onClick={() => removeMfa(enrollment.id, 'Enrollment cancelled')}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" loading={busyAction === 'mfa-enroll'} onClick={enrollMfa}>Add authenticator</Button>
              )}
            </CardContent>
          </Card>
          <Card className="max-w-2xl">
            <CardHeader><CardTitle>Sessions</CardTitle></CardHeader>
            <CardContent>
              <Button variant="outline" onClick={async () => {
                const { error } = await supabase.auth.signOut({ scope: 'others' })
                if (error) toast.error(error.message)
                else toast.success('Other sessions signed out')
              }}>Sign out other sessions</Button>
            </CardContent>
          </Card>
        </TabsContent>

        {isAdmin && <TabsContent value="members" className="mt-6">
          <Card className="max-w-4xl">
            <CardHeader><CardTitle>Workspace members</CardTitle></CardHeader>
            <CardContent className="space-y-6">
              {isAdmin ? (
                <form className="flex flex-col gap-3 sm:flex-row" onSubmit={inviteMember}>
                  <Input type="email" placeholder="colleague@example.com" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} required />
                  <select aria-label="Invitation role" className={roleSelectClass} value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Role)}>
                    <option value="USER">Member</option>
                    <option value="ADMIN">Admin</option>
                  </select>
                  <Button type="submit" loading={busyAction === 'invite'}>Invite</Button>
                </form>
              ) : (
                <p className="text-sm text-muted-foreground">Only workspace admins can invite or manage members.</p>
              )}

              {invitations.length > 0 && (
                <div className="space-y-3">
                  <p className="text-sm font-medium">Pending invitations</p>
                  {invitations.map((invitation) => (
                    <div key={invitation.id} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{invitation.email}</p>
                        <p className="text-xs text-muted-foreground">Expires {new Date(invitation.expiresAt).toLocaleDateString()}</p>
                      </div>
                      {isAdmin && (
                        <>
                          <select aria-label={`Role for ${invitation.email}`} className={roleSelectClass} disabled={busyAction === `invite-${invitation.id}`} value={invitation.role} onChange={(event) => updateInvitation(invitation, event.target.value as Role)}>
                            <option value="USER">Member</option>
                            <option value="ADMIN">Admin</option>
                          </select>
                          <Button variant="outline" loading={busyAction === `invite-${invitation.id}`} onClick={() => resendInvitation(invitation)}>Resend</Button>
                          <Button variant="outline" disabled={busyAction === `invite-${invitation.id}`} onClick={() => revokeInvitation(invitation)}>Revoke</Button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-3">
                <p className="text-sm font-medium">Members</p>
                {members.map((member) => {
                  const isSelf = member.id === profile?.id
                  return (
                    <div key={member.id} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{member.name || member.email || 'Member'}{isSelf ? ' (you)' : ''}</p>
                        <p className="truncate text-xs text-muted-foreground">{member.email} · {member.isActive ? 'Active' : 'Suspended'}</p>
                      </div>
                      {isAdmin && (
                        <>
                          <select aria-label={`Role for ${member.email || member.name || 'member'}`} className={roleSelectClass} disabled={isSelf || busyAction === `member-${member.id}`} value={member.role} onChange={(event) => updateMember(member, { role: event.target.value as Role })}>
                            <option value="USER">Member</option>
                            <option value="ADMIN">Admin</option>
                          </select>
                          <Button variant="outline" loading={busyAction === `member-${member.id}`} disabled={isSelf} onClick={() => updateMember(member, { isActive: !member.isActive })}>{member.isActive ? 'Suspend' : 'Reactivate'}</Button>
                          <Button variant="destructive" disabled={isSelf || busyAction === `member-${member.id}`} onClick={() => removeMember(member)}>Remove</Button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>}

        {isAdmin && <TabsContent value="workspace" className="mt-6 space-y-6">
          {organization && (
            <Card className="max-w-2xl">
              <CardHeader><CardTitle>Workspace details</CardTitle></CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={saveWorkspace}>
                  <div className="space-y-2">
                    <Label htmlFor="workspace-name">Workspace name</Label>
                    <Input id="workspace-name" value={organization.name} disabled={!isAdmin} onChange={(event) => setOrganization({ ...organization, name: event.target.value })} required />
                  </div>
                  <Button type="submit" loading={busyAction === 'workspace'} disabled={!isAdmin}>Save workspace</Button>
                </form>
              </CardContent>
            </Card>
          )}
          <Card className="max-w-2xl">
            <CardHeader><CardTitle>Connection scanning</CardTitle></CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">Learn from connected tools</p>
                  <p className="text-sm text-muted-foreground">When you connect a tool, Sublime samples recent usage (read-only) to learn how your team works.</p>
                </div>
                <Switch checked={organization?.settings?.disableConnectionScans !== true} disabled={busyAction === 'scanning' || !isAdmin || !organization} onCheckedChange={toggleConnectionScanning} />
              </div>
              {!isAdmin && <p className="mt-3 text-xs text-muted-foreground">Only workspace admins can change this setting.</p>}
            </CardContent>
          </Card>
          <LearningsPanel />
        </TabsContent>}
      </Tabs>
    </div>
  )
}
