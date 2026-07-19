'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'
import { resizeImageToDataUrl } from '@/lib/client/resize-image'
import { BILLING_PLAN_CATALOG } from '@/lib/billing/catalog'
import { LearningsPanel } from './learnings-panel'

type Profile = { name: string; email: string; imageUrl: string | null; role: string }

/** PATCH /api/settings/profile caps imageUrl at 2048 characters. */
const AVATAR_URL_MAX = 2048

/**
 * Downscale an uploaded photo to a small square data URL that fits the
 * profile imageUrl limit: PNG first (crispest), then increasingly compact
 * JPEGs until one fits.
 */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  const attempts: Array<{ size: number; mimeType: 'image/png' | 'image/jpeg'; quality?: number }> = [
    { size: 64, mimeType: 'image/png' },
    { size: 64, mimeType: 'image/jpeg', quality: 0.8 },
    { size: 48, mimeType: 'image/jpeg', quality: 0.7 },
    { size: 32, mimeType: 'image/jpeg', quality: 0.6 },
    { size: 24, mimeType: 'image/jpeg', quality: 0.5 },
  ]
  for (const { size, mimeType, quality } of attempts) {
    const dataUrl = await resizeImageToDataUrl(file, size, { mimeType, quality })
    if (dataUrl.length <= AVATAR_URL_MAX) return dataUrl
  }
  throw new Error('Could not shrink that image enough — try a simpler one.')
}
type Factor = { id: string; friendly_name?: string; status: string }
type Member = { id: string; email: string | null; name: string | null; role: 'ADMIN' | 'USER'; isActive: boolean }
type Invitation = { id: string; email: string; role: 'ADMIN' | 'USER'; expiresAt: string; createdAt: string }
type OrgSettings = {
  disableConnectionScans?: boolean
  knowledgeCaptureEnabled?: boolean
  captureAgentRunKnowledge?: boolean
  captureFlowRunKnowledge?: boolean
  captureConnectedKnowledge?: boolean
  retainKnowledgeOnDisconnect?: boolean
  zeroDataRetention?: boolean
}

export default function SettingsPage() {
  const supabase = createClient()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [savedProfileName, setSavedProfileName] = useState('')
  const [savingAvatar, setSavingAvatar] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [factors, setFactors] = useState<Factor[]>([])
  const [enrollment, setEnrollment] = useState<{ id: string; qr: string } | null>(null)
  const [code, setCode] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [orgSettings, setOrgSettings] = useState<OrgSettings>({})
  const [orgName, setOrgName] = useState('')
  const [savedOrgName, setSavedOrgName] = useState('')
  const [savingOrgName, setSavingOrgName] = useState(false)
  const [deletingWorkspace, setDeletingWorkspace] = useState(false)
  const [savingScanToggle, setSavingScanToggle] = useState(false)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [orgPlan, setOrgPlan] = useState('TRIAL')
  const [grandfathered, setGrandfathered] = useState(false)
  // Deep-linkable tabs (e.g. /settings?tab=billing from the Stripe portal return URL).
  const [initialTab] = useState(() => {
    if (typeof window === 'undefined') return 'profile'
    const tab = new URLSearchParams(window.location.search).get('tab')
    return tab && ['profile', 'security', 'members', 'workspace', 'billing'].includes(tab) ? tab : 'profile'
  })

  async function load() {
    setLoadingSettings(true)
    setLoadError('')
    try {
      const [response, factorResult, memberResponse, orgResponse] = await Promise.all([
        fetch('/api/settings/profile', { cache: 'no-store' }), supabase.auth.mfa.listFactors(),
        fetch('/api/settings/members', { cache: 'no-store' }), fetch('/api/organizations', { cache: 'no-store' }),
      ])
      const [data, memberData, orgData] = await Promise.all([
        response.json().catch(() => ({})), memberResponse.json().catch(() => ({})), orgResponse.json().catch(() => ({})),
      ])
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not load your profile.')
      if (!memberResponse.ok || !memberData.success) throw new Error(memberData.error || 'Could not load workspace members.')
      if (!orgResponse.ok || !orgData.success) throw new Error(orgData.error || 'Could not load workspace settings.')
      if (factorResult.error) throw factorResult.error
      setProfile(data.profile); setEmail(data.profile.email || '')
      setSavedProfileName(data.profile.name || '')
      setFactors((factorResult.data?.totp || []) as Factor[])
      setMembers(memberData.members); setInvitations(memberData.invitations || [])
      setOrgSettings((orgData.organizations?.[0]?.settings || {}) as OrgSettings)
      setOrgPlan(orgData.organizations?.[0]?.plan || 'TRIAL')
      setGrandfathered(Boolean(orgData.organizations?.[0]?.grandfatheredAt))
      setOrgName(orgData.organizations?.[0]?.name || '')
      setSavedOrgName(orgData.organizations?.[0]?.name || '')
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Could not load settings.')
    } finally { setLoadingSettings(false) }
  }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Stripe routes bounce back here with ?billing_error= when checkout or the
  // portal can't start (misconfiguration or Stripe outage) — surface it
  // instead of leaving a silently dead button.
  useEffect(() => {
    const billingError = new URLSearchParams(window.location.search).get('billing_error')
    if (!billingError) return
    toast.error(
      billingError === 'portal'
        ? 'We could not open the billing portal. Please try again or contact hello@trysublime.io.'
        : 'We could not start checkout. Please try again or contact hello@trysublime.io.',
    )
    const url = new URL(window.location.href)
    url.searchParams.delete('billing_error')
    window.history.replaceState(null, '', url.toString())
  }, [])

  async function saveOrgName(event: React.FormEvent) {
    event.preventDefault()
    const name = orgName.trim()
    if (!name || name === savedOrgName) return
    setSavingOrgName(true)
    try {
      const response = await fetch('/api/organizations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) { toast.error(data.error || 'Could not rename the workspace'); return }
      setOrgName(data.organization?.name || name)
      setSavedOrgName(data.organization?.name || name)
      toast.success('Workspace renamed')
    } finally {
      setSavingOrgName(false)
    }
  }

  async function deleteWorkspace() {
    const typed = window.prompt(`This permanently deletes the workspace, every member, and all its agents, flows, and runs.\n\nType the workspace name (${savedOrgName}) to confirm:`)
    if (typed === null) return
    setDeletingWorkspace(true)
    try {
      const response = await fetch('/api/organizations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName: typed }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) { toast.error(data.error || 'Could not delete the workspace'); return }
      await supabase.auth.signOut()
      window.location.replace('/')
    } finally {
      setDeletingWorkspace(false)
    }
  }

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
    if (!profile) return
    const name = profile.name?.trim()
    if (!name || name === savedProfileName) return
    const response = await fetch('/api/settings/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...profile, name }) })
    const data = await response.json()
    if (!response.ok) return toast.error(data.error || 'Could not save profile')
    setProfile(data.profile); setSavedProfileName(data.profile?.name || name); toast.success('Profile saved')
  }

  /** PATCH just the photo, keeping the last-saved name (the schema requires one). */
  async function saveAvatar(imageUrl: string | null) {
    if (!profile) return
    const name = savedProfileName.trim() || profile.name?.trim()
    if (!name) return toast.error('Set a display name before adding a photo.')
    setSavingAvatar(true)
    try {
      const response = await fetch('/api/settings/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, imageUrl }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(data.error || 'Could not update your photo')
      // Merge instead of replacing so an in-progress name edit isn't clobbered.
      setProfile((current) => (current ? { ...current, imageUrl: data.profile?.imageUrl ?? imageUrl } : current))
      toast.success(imageUrl ? 'Photo updated' : 'Photo removed')
    } finally {
      setSavingAvatar(false)
    }
  }

  async function uploadAvatar(file: File) {
    setSavingAvatar(true)
    try {
      const imageUrl = await fileToAvatarDataUrl(file)
      await saveAvatar(imageUrl)
    } catch (cause) {
      toast.error(cause instanceof Error && cause.message ? cause.message : 'Could not read that image — try a PNG or JPEG.')
    } finally {
      setSavingAvatar(false)
    }
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
    {loadError && <Card className="border-red-200"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><p className="text-sm text-red-700">{loadError}</p><Button variant="outline" onClick={() => void load()} loading={loadingSettings}>Try again</Button></CardContent></Card>}
    {loadingSettings && !profile ? (
      <div className="space-y-6" aria-busy="true" aria-label="Loading settings">
        <Skeleton className="h-9 w-80 max-w-full rounded-lg" />
        <Skeleton className="h-56 max-w-2xl rounded-xl" />
        <Skeleton className="h-40 max-w-2xl rounded-xl" />
      </div>
    ) : (
    <Tabs defaultValue={initialTab}><TabsList className="flex h-auto flex-wrap"><TabsTrigger value="profile">Profile</TabsTrigger><TabsTrigger value="security">Security</TabsTrigger><TabsTrigger value="members">Members</TabsTrigger><TabsTrigger value="workspace">Workspace</TabsTrigger><TabsTrigger value="billing">Billing</TabsTrigger></TabsList>
      <TabsContent value="profile" className="mt-6">{profile && <Card className="max-w-2xl"><CardHeader><CardTitle>Profile</CardTitle></CardHeader><CardContent><form className="space-y-4" onSubmit={saveProfile}>
        <div className="flex items-center gap-4">
          {profile.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={profile.imageUrl} alt="Profile photo" className="h-14 w-14 rounded-full border object-cover" />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-lg font-semibold text-muted-foreground" aria-hidden>
              {(profile.name || profile.email || 'U').trim().charAt(0).toUpperCase()}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" loading={savingAvatar} onClick={() => avatarInputRef.current?.click()}>
              {profile.imageUrl ? 'Change photo' : 'Upload photo'}
            </Button>
            {profile.imageUrl && (
              <Button type="button" variant="ghost" size="sm" disabled={savingAvatar} onClick={() => void saveAvatar(null)}>Remove</Button>
            )}
          </div>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void uploadAvatar(file) }}
          />
        </div>
        <div className="space-y-2"><Label htmlFor="name">Display name</Label><Input id="name" value={profile.name || ''} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></div>
        <Button type="submit" disabled={!profile.name?.trim() || profile.name.trim() === savedProfileName}>Save profile</Button>
      </form></CardContent></Card>}
        <Card className="mt-6 max-w-2xl border-red-200"><CardHeader><CardTitle>Delete account</CardTitle></CardHeader><CardContent><p className="mb-4 text-sm text-muted-foreground">Permanently removes your account. If you are the only member, the workspace and its data are also deleted.</p><Button variant="outline" onClick={async () => { if (window.prompt('Type DELETE to permanently delete your account') !== 'DELETE') return; const response = await fetch('/api/settings/profile', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'DELETE' }) }); const data = await response.json(); if (!response.ok) return toast.error(data.error || 'Could not delete account'); await supabase.auth.signOut(); window.location.replace('/') }}>Delete account</Button></CardContent></Card>
      </TabsContent>
      <TabsContent value="security" className="mt-6 space-y-6">
        <Card className="max-w-2xl"><CardHeader><CardTitle>Email address</CardTitle></CardHeader><CardContent className="flex flex-col gap-3 sm:flex-row"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /><Button onClick={changeEmail}>Change email</Button></CardContent></Card>
        <Card className="max-w-2xl"><CardHeader><CardTitle>Password</CardTitle></CardHeader><CardContent className="flex flex-col gap-3 sm:flex-row"><Input type="password" autoComplete="new-password" placeholder="At least 12 characters" value={password} onChange={(e) => setPassword(e.target.value)} /><Button onClick={changePassword}>Change password</Button></CardContent></Card>
        <Card className="max-w-2xl"><CardHeader><CardTitle>Two-factor authentication</CardTitle></CardHeader><CardContent className="space-y-4">
          {factors.map((factor) => <div key={factor.id} className="flex items-center justify-between rounded-md border p-3"><span className="text-sm">{factor.friendly_name || 'Authenticator app'} · {factor.status}</span><Button variant="outline" onClick={() => removeMfa(factor.id)}>Remove</Button></div>)}
          {enrollment ? <div className="space-y-3"><div className="w-48" dangerouslySetInnerHTML={{ __html: enrollment.qr }} /><p className="text-sm text-muted-foreground">Scan the code, then enter the six-digit verification code.</p><div className="flex gap-3"><Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /><Button onClick={verifyMfa}>Verify</Button></div></div> : <Button variant="outline" onClick={enrollMfa}>Add authenticator</Button>}
        </CardContent></Card>
        <Card className="max-w-2xl"><CardHeader><CardTitle>Sessions</CardTitle></CardHeader><CardContent><Button variant="outline" onClick={async () => { const { error } = await supabase.auth.signOut({ scope: 'others' }); if (error) toast.error(error.message); else toast.success('Other sessions signed out') }}>Sign out other sessions</Button></CardContent></Card>
      </TabsContent>
      <TabsContent value="members" className="mt-6"><Card className="max-w-3xl"><CardHeader><CardTitle>Workspace members</CardTitle></CardHeader><CardContent className="space-y-4">
        {profile?.role === 'ADMIN' ? <form className="flex flex-col gap-3 sm:flex-row" onSubmit={inviteMember}><Input type="email" placeholder="colleague@example.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required /><Button type="submit">Invite</Button></form> : <p className="text-sm text-muted-foreground">Only workspace admins can invite or manage members.</p>}
        {invitations.length > 0 && <div className="space-y-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pending invitations</p>{invitations.map((invitation) => <div key={invitation.id} className="flex flex-wrap items-center gap-3 rounded-md border border-dashed p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{invitation.email}</p><p className="text-xs text-muted-foreground">{invitation.role} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</p></div>{profile?.role === 'ADMIN' && <Button variant="outline" size="sm" onClick={() => revokeInvitation(invitation)}>Revoke</Button>}</div>)}</div>}
        {members.map((member) => <div key={member.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{member.name || member.email}</p><p className="truncate text-xs text-muted-foreground">{member.email}</p></div>{profile?.role === 'ADMIN' ? <><Button variant="outline" onClick={() => updateMember(member, { role: member.role === 'ADMIN' ? 'USER' : 'ADMIN' })}>{member.role}</Button><Button variant="outline" onClick={() => updateMember(member, { isActive: !member.isActive })}>{member.isActive ? 'Suspend' : 'Reactivate'}</Button></> : <span className="text-xs text-muted-foreground">{member.role}</span>}</div>)}
      </CardContent></Card></TabsContent>
      <TabsContent value="workspace" className="mt-6">
        <Card className="mb-6 max-w-2xl">
          <CardHeader><CardTitle>Workspace name</CardTitle></CardHeader>
          <CardContent>
            {profile?.role === 'ADMIN' ? (
              <form className="flex flex-col gap-3 sm:flex-row" onSubmit={saveOrgName}>
                <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} maxLength={80} required aria-label="Workspace name" />
                <Button type="submit" loading={savingOrgName} disabled={savingOrgName || !orgName.trim() || orgName.trim() === savedOrgName}>Rename</Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">{savedOrgName || '—'} <span className="text-xs">(only workspace admins can rename)</span></p>
            )}
          </CardContent>
        </Card>
        {profile?.role === 'ADMIN' && <Card className="mb-6 max-w-2xl"><CardHeader><CardTitle>Audit log</CardTitle></CardHeader><CardContent><p className="mb-3 text-sm text-muted-foreground">Download an organization-scoped CSV record of agent actions and external tool use.</p><Button variant="outline" asChild><a href="/api/audit/export">Download audit CSV</a></Button></CardContent></Card>}
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
        <KnowledgeRetentionCard isAdmin={profile?.role === 'ADMIN'} plan={orgPlan} />
        <LearningsPanel />
        {profile?.role === 'ADMIN' && <PlatformServicesCard />}
        {profile?.role === 'ADMIN' && (
          <Card className="mt-6 max-w-2xl border-red-200">
            <CardHeader><CardTitle>Delete workspace</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-4 text-sm text-muted-foreground">
                Permanently deletes this workspace for every member — all agents, flows, runs, connections, and history. Members&apos; next sign-in starts a fresh personal workspace. This cannot be undone.
              </p>
              <Button variant="outline" className="border-red-300 text-red-700 hover:bg-red-50" loading={deletingWorkspace} disabled={deletingWorkspace} onClick={deleteWorkspace}>
                Delete workspace
              </Button>
            </CardContent>
          </Card>
        )}
      </TabsContent>
      <TabsContent value="billing" className="mt-6">
        <Card className="max-w-2xl"><CardHeader><CardTitle>Plan &amp; billing</CardTitle></CardHeader><CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">Current plan</p>
              <p className="text-xs text-muted-foreground">
                {({
                  TRIAL: 'Payment required',
                  STARTER: `Individual — ${BILLING_PLAN_CATALOG.individual.priceWithCadence}`,
                  PROFESSIONAL: `Team — ${BILLING_PLAN_CATALOG.team.priceWithCadence}`,
                  BUSINESS: `Business — ${BILLING_PLAN_CATALOG.business.priceWithCadence}`,
                  ENTERPRISE: 'Enterprise',
                } as Record<string, string>)[orgPlan] || orgPlan}
              </p>
            </div>
            {orgPlan !== 'TRIAL' && !grandfathered && <Button variant="outline" onClick={() => { window.location.href = '/api/stripe/portal' }}>Manage billing</Button>}
          </div>
          {grandfathered ? (
            <p className="text-sm text-muted-foreground">Grandfathered test account — Enterprise access is permanently included and no payment is required.</p>
          ) : orgPlan === 'TRIAL' ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Pick a plan to start using the platform. Billing begins at checkout, you can cancel anytime, and payments are handled securely by Stripe.</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => { window.location.href = '/api/stripe/checkout?plan=individual' }}>Individual — {BILLING_PLAN_CATALOG.individual.priceWithCadence}</Button>
                <Button onClick={() => { window.location.href = '/api/stripe/checkout?plan=team' }}>Team — {BILLING_PLAN_CATALOG.team.priceWithCadence}</Button>
                <Button onClick={() => { window.location.href = '/api/stripe/checkout?plan=business' }}>Business — {BILLING_PLAN_CATALOG.business.priceWithCadence}</Button>
                <Button variant="outline" onClick={() => { window.location.href = '/contact?reason=enterprise' }}>Enterprise — contact sales</Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Upgrades, downgrades, payment methods, and cancellation are all handled in the Stripe billing portal via “Manage billing”.</p>
          )}
          <PlanUsageCard />
        </CardContent></Card>
      </TabsContent>
    </Tabs>
    )}
  </div>
}

type Capability = { key: string; label: string; configured: boolean; detail: string }

/**
 * Admin visibility into the deployment's optional services — several features
 * silently degrade when unconfigured (semantic search, push, graph memory),
 * and this card is where that state stops being invisible.
 */
type BillingLimits = { label: string; seats: string; monthlyCredits: string; maxAgents: string; maxFlows: string; maxIntegrations: string; maxSpecialistAreas: string }
type BillingUsage = { agents: number; flows: number; integrations: number; members: number; creditsUsed: number; topupCredits?: number }

type KnowledgeSettings = {
  captureEnabled: boolean
  captureAgentRuns: boolean
  captureFlowRuns: boolean
  captureConnectedData: boolean
  retainOnDisconnect: boolean
  zeroDataRetention: boolean
}

type KnowledgeSummary = {
  documents: number
  characters: number
  passages: number
  bySource: Record<string, number>
}

const KNOWLEDGE_SETTING_KEYS = {
  captureEnabled: 'knowledgeCaptureEnabled',
  captureAgentRuns: 'captureAgentRunKnowledge',
  captureFlowRuns: 'captureFlowRunKnowledge',
  captureConnectedData: 'captureConnectedKnowledge',
  retainOnDisconnect: 'retainKnowledgeOnDisconnect',
  zeroDataRetention: 'zeroDataRetention',
} as const

function KnowledgeRetentionCard({ isAdmin, plan }: { isAdmin: boolean; plan: string }) {
  const [settings, setSettings] = useState<KnowledgeSettings | null>(null)
  const [summary, setSummary] = useState<KnowledgeSummary | null>(null)
  const [saving, setSaving] = useState<keyof KnowledgeSettings | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/knowledge', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data?.success) return
        setSettings(data.settings)
        setSummary(data.summary)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  async function updateSetting(key: keyof KnowledgeSettings, value: boolean) {
    if (!settings) return
    setSaving(key)
    try {
      const response = await fetch('/api/organizations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { [KNOWLEDGE_SETTING_KEYS[key]]: value } }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(data.error || 'Could not update knowledge retention')
      setSettings((current) => current ? { ...current, [key]: value } : current)
      toast.success('Knowledge retention updated')
    } finally {
      setSaving(null)
    }
  }

  const rows: Array<{ key: keyof KnowledgeSettings; label: string; detail: string; enterpriseOnly?: boolean }> = [
    { key: 'captureEnabled', label: 'Retain workspace knowledge', detail: 'Store useful business context as durable, encrypted workspace knowledge.' },
    { key: 'captureAgentRuns', label: 'Learn from agent outcomes', detail: 'Promote completed agent work before temporary run history is pruned.' },
    { key: 'captureFlowRuns', label: 'Learn from flow outcomes', detail: 'Keep successful workflow results available to future agents and searches.' },
    { key: 'captureConnectedData', label: 'Learn from connected tools', detail: 'Retain redacted activity summaries and connection profiles during live sync.' },
    { key: 'retainOnDisconnect', label: 'Keep knowledge after disconnect', detail: 'Remove credentials and live access while preserving already learned business context.' },
    { key: 'zeroDataRetention', label: 'Zero-data retention mode', detail: 'Enterprise override that disables durable capture and expires temporary execution data.', enterpriseOnly: true },
  ]

  return (
    <Card className="mt-6 max-w-2xl">
      <CardHeader><CardTitle>Knowledge retention</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Sublime retains useful workspace context by default. Stored knowledge is encrypted, credential-shaped values are redacted, and providers are not permitted to train on your data.
        </p>
        {summary && (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border p-3"><p className="text-lg font-semibold">{summary.documents.toLocaleString()}</p><p className="text-xs text-muted-foreground">Documents</p></div>
            <div className="rounded-md border p-3"><p className="text-lg font-semibold">{summary.passages.toLocaleString()}</p><p className="text-xs text-muted-foreground">Passages</p></div>
            <div className="rounded-md border p-3"><p className="text-lg font-semibold">{Object.keys(summary.bySource).length}</p><p className="text-xs text-muted-foreground">Live sources</p></div>
          </div>
        )}
        {settings && rows.map((row) => {
          const locked = row.enterpriseOnly && plan !== 'ENTERPRISE'
          return (
            <div key={row.key} className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">{row.label}{locked ? ' · Enterprise' : ''}</p>
                <p className="text-xs text-muted-foreground">{row.detail}</p>
              </div>
              <Switch
                checked={settings[row.key]}
                disabled={!isAdmin || locked || saving !== null}
                onCheckedChange={(checked) => void updateSetting(row.key, checked)}
              />
            </div>
          )
        })}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" asChild><a href="/api/knowledge?download=1">Export retained knowledge</a></Button>
          <span className="text-xs text-muted-foreground">Deleting the workspace permanently removes its retained knowledge.</span>
        </div>
        {!isAdmin && <p className="text-xs text-muted-foreground">Only workspace admins can change retention settings.</p>}
      </CardContent>
    </Card>
  )
}

/**
 * What the current plan includes vs. what the workspace is using — the numbers
 * behind the create-time PLAN_LIMIT errors, so hitting a cap is never a
 * surprise. Reads /api/billing/status (ungated: works even mid-lockout).
 */
function PlanUsageCard() {
  const [limits, setLimits] = useState<BillingLimits | null>(null)
  const [usage, setUsage] = useState<BillingUsage | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/billing/status', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data?.success) return
        if (data.limits) setLimits(data.limits)
        if (data.usage) setUsage(data.usage)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!limits || !usage) return null
  const topup = usage.topupCredits ?? 0
  const creditCap = limits.monthlyCredits === 'Unlimited'
    ? 'Unlimited'
    : (Number(limits.monthlyCredits) + topup).toLocaleString() + (topup > 0 ? ` (incl. ${topup.toLocaleString()} extra)` : '')
  const rows = [
    { label: 'Credits this month', used: usage.creditsUsed.toLocaleString(), cap: creditCap },
    { label: 'Agents', used: String(usage.agents), cap: limits.maxAgents },
    { label: 'Flows', used: String(usage.flows), cap: limits.maxFlows },
    { label: 'Integrations', used: String(usage.integrations), cap: limits.maxIntegrations },
    { label: 'Seats', used: String(usage.members), cap: limits.seats },
    { label: 'Core specialist areas', used: 'Plan access', cap: limits.maxSpecialistAreas },
  ]
  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-medium">Usage &amp; limits — {limits.label} plan</p>
      <div className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{row.label}</span>
            <span className="font-medium">{row.used} <span className="text-muted-foreground">/ {row.cap}</span></span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        {limits.monthlyCredits !== 'Unlimited' && (
          <Button variant="outline" size="sm" asChild><a href="/api/stripe/topup">Buy additional credits</a></Button>
        )}
        <Button variant="ghost" size="sm" asChild><a href="/contact?reason=billing">Talk to us about custom usage</a></Button>
      </div>
    </div>
  )
}

function PlatformServicesCard() {
  const [capabilities, setCapabilities] = useState<Capability[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    fetch('/api/system/capabilities', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok || !data.success) throw new Error(data.error || 'Could not load service status.')
        if (!cancelled) setCapabilities(data.capabilities)
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load service status.') })
    return () => { cancelled = true }
  }, [])
  return (
    <Card className="mt-6 max-w-2xl">
      <CardHeader><CardTitle>Platform services</CardTitle></CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-red-700">{error}</p>
        ) : !capabilities ? (
          <p className="text-sm text-muted-foreground">Checking service status…</p>
        ) : (
          <ul className="divide-y">
            {capabilities.map((capability) => (
              <li key={capability.key} className="flex items-start gap-3 py-2.5">
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${capability.configured ? 'bg-emerald-500' : 'bg-gray-300'}`}
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {capability.label}
                    <span className={`ml-2 text-xs font-normal ${capability.configured ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                      {capability.configured ? 'Active' : 'Not configured'}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">{capability.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
