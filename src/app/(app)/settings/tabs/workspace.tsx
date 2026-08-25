'use client'

/**
 * Workspace-level configuration: name, audit export, connection scanning,
 * knowledge retention, intelligence panels, platform services, and deletion.
 * The three cards below (knowledge, services) moved here with the tab — they
 * were private to the old monolithic settings page and this is their only
 * consumer.
 */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { LearningsPanel } from '../learnings-panel'
import { BehaviorPatternsPanel } from '../behavior-patterns-panel'
import { IntelligenceHealthCard } from '../intelligence-health-card'
import { WorkspaceVariablesCard } from '../workspace-variables-card'
import type { OrgSettings } from './types'

export function WorkspaceTab({
  isAdmin,
  orgPlan,
  orgSettings,
  setOrgSettings,
  orgName,
  setOrgName,
  savedOrgName,
  setSavedOrgName,
}: Readonly<{
  isAdmin: boolean
  orgPlan: string
  orgSettings: OrgSettings
  setOrgSettings: (settings: OrgSettings) => void
  orgName: string
  setOrgName: (name: string) => void
  savedOrgName: string
  setSavedOrgName: (name: string) => void
}>) {
  const supabase = createClient()
  const [savingOrgName, setSavingOrgName] = useState(false)
  const [deletingWorkspace, setDeletingWorkspace] = useState(false)
  const [savingScanToggle, setSavingScanToggle] = useState(false)

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

  return (
    <>
      <Card className="mb-6 max-w-2xl">
        <CardHeader><CardTitle>Workspace name</CardTitle></CardHeader>
        <CardContent>
          {isAdmin ? (
            <form className="flex flex-col gap-3 sm:flex-row" onSubmit={saveOrgName}>
              <Input value={orgName} onChange={(e) => setOrgName(e.target.value)} maxLength={80} required aria-label="Workspace name" />
              <Button type="submit" loading={savingOrgName} disabled={savingOrgName || !orgName.trim() || orgName.trim() === savedOrgName}>Rename</Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">{savedOrgName || '—'} <span className="text-xs">(only workspace admins can rename)</span></p>
          )}
        </CardContent>
      </Card>
      {isAdmin && <Card className="mb-6 max-w-2xl"><CardHeader><CardTitle>Audit log</CardTitle></CardHeader><CardContent><p className="mb-3 text-sm text-muted-foreground">Download an organization-scoped CSV record of agent actions and external tool use.</p><Button variant="outline" asChild><a href="/api/audit/export">Download audit CSV</a></Button></CardContent></Card>}
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
              disabled={savingScanToggle || !isAdmin}
              onCheckedChange={toggleConnectionScanning}
            />
          </div>
          {!isAdmin && (
            <p className="mt-3 text-xs text-muted-foreground">Only workspace admins can change this setting.</p>
          )}
        </CardContent>
      </Card>
      <KnowledgeRetentionCard isAdmin={isAdmin} plan={orgPlan} />
      <WorkspaceVariablesCard isAdmin={isAdmin} />
      <LearningsPanel isAdmin={isAdmin} />
      <BehaviorPatternsPanel />
      {isAdmin && <IntelligenceHealthCard />}
      {isAdmin && <PlatformServicesCard />}
      {isAdmin && (
        <Card className="mt-6 max-w-2xl border-destructive/30">
          <CardHeader><CardTitle>Delete workspace</CardTitle></CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">
              Permanently deletes this workspace for every member — all agents, flows, runs, connections, and history. Members&apos; next sign-in starts a fresh personal workspace. This cannot be undone.
            </p>
            <Button variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" loading={deletingWorkspace} disabled={deletingWorkspace} onClick={deleteWorkspace}>
              Delete workspace
            </Button>
          </CardContent>
        </Card>
      )}
    </>
  )
}

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

function KnowledgeRetentionCard({ isAdmin, plan }: Readonly<{ isAdmin: boolean; plan: string }>) {
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

type Capability = { key: string; label: string; configured: boolean; detail: string }

/**
 * Admin visibility into the deployment's optional services — several features
 * silently degrade when unconfigured (semantic search, push, graph memory),
 * and this card is where that state stops being invisible.
 */
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
          <p className="text-sm text-destructive">{error}</p>
        ) : !capabilities ? (
          <p className="text-sm text-muted-foreground">Checking service status…</p>
        ) : (
          <ul className="divide-y">
            {capabilities.map((capability) => (
              <li key={capability.key} className="flex items-start gap-3 py-2.5">
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${capability.configured ? 'bg-emerald-500' : 'bg-muted-foreground/35'}`}
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
