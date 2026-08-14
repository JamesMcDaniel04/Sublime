'use client'

/**
 * The settings SHELL: one shared load, a tab list, and per-tab components.
 *
 * The shared load stays here because the data genuinely spans tabs — profile
 * gates admin-only tabs, members feed both the Members tab and takeover, org
 * settings feed Workspace and Billing. Everything else (markup, mutation
 * handlers, tab-private fetches like MFA factors and billing usage) lives in
 * tabs/*, because at 670 lines the previous single-file version had become
 * unworkable to extend.
 */

import { useEffect, useState } from 'react'
import { BarChart3, Building2, CreditCard, Palette, Settings2, ShieldCheck, UserRound, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ThemeSelector } from '@/components/ui/theme-toggle'
import { ProfileTab } from './tabs/profile'
import { SecurityTab } from './tabs/security'
import { MembersTab } from './tabs/members'
import { WorkspaceTab } from './tabs/workspace'
import { BillingTab } from './tabs/billing'
import { InsightsTab } from './tabs/insights'
import type { Invitation, Member, OrgSettings, Profile } from './tabs/types'

const TAB_VALUES = ['profile', 'appearance', 'security', 'members', 'workspace', 'billing', 'insights']
/** Tabs whose CONTENT is workspace-directory or workspace-analytics data. */
const ADMIN_ONLY_TABS = ['members', 'insights']

export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [savedProfileName, setSavedProfileName] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [orgSettings, setOrgSettings] = useState<OrgSettings>({})
  const [orgName, setOrgName] = useState('')
  const [savedOrgName, setSavedOrgName] = useState('')
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [orgPlan, setOrgPlan] = useState('TRIAL')
  const [grandfathered, setGrandfathered] = useState(false)
  // Deep-linkable tabs (e.g. /settings?tab=billing from the Stripe portal return URL).
  const [initialTab] = useState(() => {
    if (typeof window === 'undefined') return 'profile'
    const tab = new URLSearchParams(window.location.search).get('tab')
    return tab && TAB_VALUES.includes(tab) ? tab : 'profile'
  })

  async function load() {
    setLoadingSettings(true)
    setLoadError('')
    try {
      const [response, memberResponse, orgResponse] = await Promise.all([
        fetch('/api/settings/profile', { cache: 'no-store' }),
        fetch('/api/settings/members', { cache: 'no-store' }),
        fetch('/api/organizations', { cache: 'no-store' }),
      ])
      const [data, memberData, orgData] = await Promise.all([
        response.json().catch(() => ({})), memberResponse.json().catch(() => ({})), orgResponse.json().catch(() => ({})),
      ])
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not load your profile.')
      // NOT an error path. /api/settings/members is admin-only (member:manage),
      // so a plain member gets a 403 here by design. Throwing would take the
      // whole settings page down for everyone who is not an admin.
      const roster = memberResponse.ok && memberData.success
      if (!orgResponse.ok || !orgData.success) throw new Error(orgData.error || 'Could not load workspace settings.')
      setProfile(data.profile)
      setSavedProfileName(data.profile.name || '')
      setMembers(roster ? memberData.members : [])
      setInvitations(roster ? memberData.invitations || [] : [])
      setOrgSettings((orgData.organizations?.[0]?.settings || {}) as OrgSettings)
      setOrgPlan(orgData.organizations?.[0]?.plan || 'TRIAL')
      setGrandfathered(Boolean(orgData.organizations?.[0]?.grandfatheredAt))
      setOrgName(orgData.organizations?.[0]?.name || '')
      setSavedOrgName(orgData.organizations?.[0]?.name || '')
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Could not load settings.')
    } finally { setLoadingSettings(false) }
  }
  useEffect(() => { void load() }, [])

  // Stripe routes bounce back here with ?billing_error= when checkout or the
  // portal can't start (misconfiguration or Stripe outage) — surface it
  // instead of leaving a silently dead button.
  useEffect(() => {
    const billingError = new URLSearchParams(window.location.search).get('billing_error')
    if (!billingError) return
    const message = {
      // Not a failure — a refusal. Billing is admin-only (billing:manage), and
      // a member who reached a Stripe route by URL deserves the real reason
      // rather than "something went wrong".
      forbidden: 'Only workspace admins can manage billing. Ask an admin to make this change.',
      portal: 'We could not open the billing portal. Please try again or contact hello@trysublime.io.',
    }[billingError] ?? 'We could not start checkout. Please try again or contact hello@trysublime.io.'
    if (billingError === 'forbidden') toast.warning(message)
    else toast.error(message)
    const url = new URL(window.location.href)
    url.searchParams.delete('billing_error')
    window.history.replaceState(null, '', url.toString())
  }, [])

  const isAdmin = profile?.role === 'ADMIN'

  return <div className="space-y-6"><PageHeader eyebrow="Account" icon={Settings2} title="Settings" description="Manage your profile, appearance, workspace, security, and billing." />
    {loadError && <Card className="border-destructive/30"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><p className="text-sm text-destructive">{loadError}</p><Button variant="outline" onClick={() => void load()} loading={loadingSettings}>Try again</Button></CardContent></Card>}
    {loadingSettings && !profile ? (
      <div className="space-y-6" aria-busy="true" aria-label="Loading settings">
        <Skeleton className="h-9 w-80 max-w-full rounded-lg" />
        <Skeleton className="h-56 max-w-2xl rounded-xl" />
        <Skeleton className="h-40 max-w-2xl rounded-xl" />
      </div>
    ) : (
    // A member deep-linking to ?tab=members (or ?tab=insights) would otherwise
    // land on a tab that no longer renders, leaving a blank panel. Tabs mounts
    // only after `load()` resolves, so isAdmin is already accurate here.
    <Tabs defaultValue={!isAdmin && ADMIN_ONLY_TABS.includes(initialTab) ? 'profile' : initialTab}><TabsList className="flex h-auto max-w-full flex-wrap justify-start">
      <TabsTrigger value="profile"><UserRound className="mr-1.5 h-3.5 w-3.5" />Profile</TabsTrigger>
      <TabsTrigger value="appearance"><Palette className="mr-1.5 h-3.5 w-3.5" />Appearance</TabsTrigger>
      <TabsTrigger value="security"><ShieldCheck className="mr-1.5 h-3.5 w-3.5" />Security</TabsTrigger>
      {/* Admin-only, matching the Insights trigger below. The tab body lists
          every member's email, role and pending invitations — workspace
          directory data. /api/settings/members refuses a MEMBER independently,
          so this is presentation, not the control. */}
      {isAdmin && <TabsTrigger value="members"><Users className="mr-1.5 h-3.5 w-3.5" />Members</TabsTrigger>}
      <TabsTrigger value="workspace"><Building2 className="mr-1.5 h-3.5 w-3.5" />Workspace</TabsTrigger>
      <TabsTrigger value="billing"><CreditCard className="mr-1.5 h-3.5 w-3.5" />Billing</TabsTrigger>
      {/* Hidden for members — presentation only; /api/settings/insights
          refuses a MEMBER independently (insights:workspace). */}
      {isAdmin && <TabsTrigger value="insights"><BarChart3 className="mr-1.5 h-3.5 w-3.5" />Insights</TabsTrigger>}
    </TabsList>
      <TabsContent value="profile" className="mt-6">
        {profile && (
          <ProfileTab
            profile={profile}
            setProfile={(updater) => setProfile(updater)}
            savedProfileName={savedProfileName}
            onSavedName={setSavedProfileName}
          />
        )}
      </TabsContent>
      <TabsContent value="appearance" className="mt-6">
        <Card className="max-w-3xl" variant="raised">
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Choose how Sublime looks on this device. Your preference is saved automatically.</CardDescription>
          </CardHeader>
          <CardContent>
            <ThemeSelector />
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="security" className="mt-6 space-y-6">
        <SecurityTab initialEmail={profile?.email || ''} />
      </TabsContent>
      {isAdmin && (
        <TabsContent value="members" className="mt-6">
          <MembersTab isAdmin={isAdmin} members={members} invitations={invitations} onReload={load} />
        </TabsContent>
      )}
      <TabsContent value="workspace" className="mt-6">
        <WorkspaceTab
          isAdmin={isAdmin}
          orgPlan={orgPlan}
          orgSettings={orgSettings}
          setOrgSettings={setOrgSettings}
          orgName={orgName}
          setOrgName={setOrgName}
          savedOrgName={savedOrgName}
          setSavedOrgName={setSavedOrgName}
        />
      </TabsContent>
      <TabsContent value="billing" className="mt-6">
        <BillingTab orgPlan={orgPlan} grandfathered={grandfathered} isAdmin={isAdmin} />
      </TabsContent>
      {isAdmin && (
        <TabsContent value="insights" className="mt-6">
          <InsightsTab members={members} />
        </TabsContent>
      )}
    </Tabs>
    )}
  </div>
}
