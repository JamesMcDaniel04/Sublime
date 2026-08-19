'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useScopedHref } from '@/lib/client/scoped-href'
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  Gauge,
  ImagePlus,
  ListTree,
  Loader2,
  Lock,
  LogOut,
  MessageSquarePlus,
  PanelLeft,
  PanelLeftClose,
  Play,
  Plug,
  Plus,
  Search,
  Settings,
  Sparkles,
  Target,
  Trash2,
  Workflow,
} from 'lucide-react'
import { toast } from 'sonner'
import { CommandPalette } from '@/components/search/command-palette'
import { NotificationBell } from '@/components/notifications/notification-bell'
import { FeedbackDialog } from '@/components/feedback/feedback-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuth } from '@/hooks/use-auth'
import { normalizeShareValue } from '@/components/share-control'
import { resizeImageToDataUrl } from '@/lib/client/resize-image'
import { getSnapshot, scopeSnapshot } from '@/lib/client/snapshot'
import { prefetchCachedJson, scopeCachedJson } from '@/lib/client/use-cached-json'
import { cn } from '@/lib/utils'
import type { Agent as AgentType } from '@/lib/types'

type Agent = Pick<AgentType, 'id' | 'title' | 'description' | 'instructions' | 'icon' | 'folder' | 'visibility'>

type Organization = { id: string; name: string; slug: string; plan: string; logoUrl?: string | null }

/** Default workspace avatar — the Sublime mark, until an org uploads its own. */
const DEFAULT_ORG_LOGO = '/sublime-icon.png'

type Usage = { executions: number; inputTokens: number; outputTokens: number; exempt?: boolean }

// Module-level snapshot of the sidebar's fetched data, persisted across the
// component's remounts. Each top-level page renders its own <DashboardLayout>,
// so App Router remounts the Sidebar on every nav; without this it would reset
// to empty state and flash the default logo + no agents until the refetch
// resolves. Seeding state from this snapshot makes a remounted sidebar paint the
// real org logo + agents instantly, then revalidate in the background.
type SidebarSnapshot = { organizations: Organization[]; activeOrgId: string | null; agents: Agent[]; usage: Usage | null }
let sidebarCache: SidebarSnapshot | null = null

const CREDIT_TOKENS = 1_000_000

// Desktop sidebar collapse (icon rail) — persisted per browser.
const COLLAPSED_KEY = 'sidebar.collapsed'
export const AGENTS_CHANGED_EVENT = 'sublime:agents-changed'

export function notifyAgentsChanged() {
  window.dispatchEvent(new CustomEvent(AGENTS_CHANGED_EVENT))
}

// Templates has no nav entry — the library lives inside Agent HQ
// (/agents?view=templates), toggled at the top of that page.
const navigation = [
  { name: 'Home', href: '/dashboard', icon: Sparkles, description: 'Your assistant across the workspace' },
  { name: 'Goals', href: '/goals', icon: Target, description: 'The numbers your workspace is accountable to' },
  // Workspace-level, so it deliberately carries no /g/<scope> prefix —
  // scopedNavHref leaves an unscoped path alone (see SCOPED_PREFIXES).
  // Activity folded in here as a tab (/traces?tab=activity) — runs and tool
  // history are one question, so they are one destination.
  { name: 'Traces', href: '/traces', icon: ListTree, description: 'What your agents, flows and connected tools did' },
  { name: 'Agents', href: '/agents', icon: Bot, description: 'Specialized agents serving your goals' },
  { name: 'Flows', href: '/flows', icon: Workflow, description: 'Orchestrate multi-step work' },
  { name: 'Integrations', href: '/integrations', icon: Plug, description: 'Connect the tools you already use' },
]

function planLabel(plan: string) {
  const lower = plan.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/** Hover hint for icon-only controls (the collapsed rail). Shortcut renders
 *  inside the tooltip instead of a `title=` suffix. An optional `description`
 *  renders as a second line — the collapsed rail has no other way to show
 *  the goal-framed nav copy since native `title` is suppressed there to
 *  avoid a double tooltip (Radix + native). */
function RailTooltip({
  label,
  description,
  shortcut,
  children,
}: Readonly<{ label: string; description?: string; shortcut?: string; children: React.ReactNode }>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2">
          {label}
          {shortcut && <kbd className="rounded border border-background/30 px-1 font-mono text-[10px]">{shortcut}</kbd>}
        </span>
        {description && <span className="text-xs text-background/70">{description}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

export function Sidebar() {
  const pathname = usePathname()
  const scopedNavHref = useScopedHref()
  const router = useRouter()
  const { user, signOut, isAdmin } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggleCollapsed = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current
      try {
        if (next) window.localStorage.setItem(COLLAPSED_KEY, '1')
        else window.localStorage.removeItem(COLLAPSED_KEY)
      } catch {
        /* storage unavailable — session-only toggle */
      }
      return next
    })
  }, [])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [organizations, setOrganizations] = useState<Organization[]>(() => sidebarCache?.organizations ?? [])
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const logoInputRef = useRef<HTMLInputElement>(null)
  const [activeOrgId, setActiveOrgId] = useState<string | null>(() => sidebarCache?.activeOrgId ?? null)
  const [agents, setAgents] = useState<Agent[]>(() => sidebarCache?.agents ?? [])
  const [usage, setUsage] = useState<Usage | null>(() => sidebarCache?.usage ?? null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const userId = user?.id

  // Warm the destinations users most often visit once authentication settles.
  // This runs after the current page paints and does not delay login rendering.
  useEffect(() => {
    scopeCachedJson(userId ?? null)
    scopeSnapshot(userId ?? null)
    if (!userId) return
    const warmSecondaryData = () => {
      prefetchCachedJson([
        '/api/agent-templates',
        '/api/skills',
        '/api/flows',
        '/api/goals',
        '/api/goals/impact',
        '/api/integrations/available',
        '/api/nango/integrations',
        '/api/mcp-connections',
      ])
    }
    // Bootstrap owns first-paint data. Warm secondary destinations only when
    // the browser is idle so they cannot contend with login or the shell model.
    const idleWindow = window as Window & { requestIdleCallback?: Window['requestIdleCallback']; cancelIdleCallback?: Window['cancelIdleCallback'] }
    if (typeof idleWindow.requestIdleCallback === 'function') {
      const idleId = idleWindow.requestIdleCallback(warmSecondaryData, { timeout: 2_000 })
      return () => idleWindow.cancelIdleCallback?.(idleId)
    }
    const timer = globalThis.setTimeout(warmSecondaryData, 1_000)
    return () => globalThis.clearTimeout(timer)
  }, [userId])

  const load = useCallback(async (force = false) => {
    // One shared snapshot (deduped across the dashboard + bell within an ~8s
    // window) instead of three separate authenticated requests per poll.
    const snapshot = await getSnapshot(force ? 0 : undefined)
    const next: SidebarSnapshot = {
      organizations: snapshot.organizations || [],
      activeOrgId: snapshot.activeOrganizationId || null,
      agents: snapshot.agents || [],
      usage: snapshot.usage || null,
    }
    sidebarCache = next
    setAgents(next.agents)
    setUsage(next.usage)
    setOrganizations(next.organizations)
    setActiveOrgId(next.activeOrgId)
  }, [])

  useEffect(() => {
    load().catch(() => undefined)
    // Poll only while the tab is visible; refresh on return to the tab.
    const interval = window.setInterval(() => {
      if (!document.hidden) load().catch(() => undefined)
    }, 30000)
    const onVisible = () => {
      if (!document.hidden) load().catch(() => undefined)
    }
    const onChanged = () => load(true).catch(() => undefined)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener(AGENTS_CHANGED_EVENT, onChanged)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener(AGENTS_CHANGED_EVENT, onChanged)
    }
  }, [load])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        toggleCollapsed()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleCollapsed])

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  const activeOrg = organizations.find((org) => org.id === activeOrgId) || organizations[0] || null

  // The rail applies on desktop only: the mobile drawer (mobileOpen) always
  // renders expanded, and when closed it is off-canvas anyway.
  const rail = sidebarCollapsed && !mobileOpen

  const saveOrgLogo = async (logoUrl: string | null) => {
    setUploadingLogo(true)
    try {
      const response = await fetch('/api/organizations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logoUrl }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not update the workspace logo.')
        return
      }
      setOrganizations((previous) => {
        const updated = previous.map((org) =>
          org.id === data.organization?.id ? { ...org, logoUrl: data.organization.logoUrl } : org,
        )
        // Keep the cross-navigation snapshot in sync so the new logo doesn't
        // briefly revert on the next navigation before load() revalidates.
        if (sidebarCache) sidebarCache = { ...sidebarCache, organizations: updated }
        return updated
      })
      toast.success(logoUrl ? 'Workspace logo updated.' : 'Workspace logo removed.')
    } finally {
      setUploadingLogo(false)
    }
  }

  const uploadOrgLogo = async (file: File) => {
    try {
      const logoUrl = await resizeImageToDataUrl(file)
      await saveOrgLogo(logoUrl)
    } catch {
      toast.error('Could not read that image — try a PNG or JPEG.')
    }
  }

  const sections = useMemo(() => {
    // Bucket by the rule the ACCESS LAYER actually applies (agentReadScope): only
    // an explicit org_viewer/org_editor is shared. The legacy `'shared'` value —
    // once the default — grants nothing, so it buckets under Private (matching
    // what the access layer enforces) rather than disappearing entirely.
    const byFolder = (list: Agent[]) => {
      const folders = new Map<string, Agent[]>()
      for (const agent of list) {
        const key = agent.folder?.trim() || 'General'
        const bucket = folders.get(key)
        if (bucket) bucket.push(agent)
        else folders.set(key, [agent])
      }
      return [...folders.entries()].sort(([a], [b]) => a.localeCompare(b))
    }
    const shared = agents.filter((agent) => normalizeShareValue(agent.visibility) !== 'private')
    const personal = agents.filter((agent) => normalizeShareValue(agent.visibility) === 'private')
    return {
      workspace: byFolder(shared),
      private: byFolder(personal),
    }
  }, [agents])

  const creditPct = usage ? Math.min(100, Math.round(((usage.inputTokens + usage.outputTokens) / CREDIT_TOKENS) * 100)) : 0

  /**
   * Move an agent between folders, and — only when the drop actually crosses the
   * Workspace/Private divide — change its sharing.
   *
   * `share` is deliberately separate from `folder`: sending a visibility on every
   * folder move used to silently REVOKE an org-shared agent's access (the sidebar
   * spoke the legacy `'shared'` vocabulary, which the server normalizes to
   * private). Re-filing an agent must never change who can see it.
   */
  const moveAgent = async (agentId: string, target: { folder: string | null; share: 'org' | 'private' }) => {
    const agent = agents.find((candidate) => candidate.id === agentId)
    if (!agent) return
    const current = normalizeShareValue(agent.visibility)
    const isShared = current !== 'private'
    // Legacy `'shared'` rows normalize to private but still carry the old raw
    // value; dropping one on Private used to no-op silently. Persist the real
    // `'private'` so the row matches what the user just did.
    const sharingChanges = (target.share === 'org') !== isShared
      || (target.share === 'private' && agent.visibility !== 'private')
    if ((agent.folder || null) === target.folder && !sharingChanges) return

    // Dropping onto Workspace shares at the safest role (view). Promoting to
    // editor is a deliberate choice, made on the agent itself — not by a drag.
    const visibility = sharingChanges ? (target.share === 'org' ? 'org_viewer' : 'private') : undefined
    const response = await fetch('/api/agents', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agentId, folder: target.folder, ...(visibility ? { visibility } : {}) }),
    })
    if (!response.ok) {
      // Sharing is owner-only, so a non-owner gets a 403 here. Swallowing it left
      // the UI looking like the move worked when nothing happened.
      const data = await response.json().catch(() => ({}))
      toast.error(data.error || 'Could not move this agent.')
      notifyAgentsChanged() // re-sync so the card snaps back to the truth
      return
    }
    if (visibility === 'org_viewer') toast.success('Shared — anyone in your workspace can view and run this agent.')
    if (visibility === 'private') toast.success('Made private — only you can see this agent.')
    notifyAgentsChanged()
  }

  const runAgent = async (agent: Agent) => {
    setRunningId(agent.id)
    try {
      const res = await fetch(`/api/agents/${agent.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        if (data.result?.status === 'waiting_for_input') {
          toast(`${agent.title} needs your input`)
        } else {
          toast.success(`${agent.title} ran`)
        }
        notifyAgentsChanged()
        router.push('/agents')
      } else {
        toast.error(data.error || 'Run failed')
      }
    } catch {
      toast.error(`Could not run ${agent.title} — check your connection and try again.`)
    } finally {
      setRunningId(null)
    }
  }

  const deleteAgent = async (agent: Agent) => {
    // Optimistic: drop the row immediately, restore on failure. The forced
    // snapshot refetch (notifyAgentsChanged → load(true)) reconciles with the
    // server — and getSnapshot(0) is guaranteed to hit the network AFTER this
    // delete, not reuse a poll already on the wire (see lib/client/snapshot).
    const previous = agents
    setAgents((current) => current.filter((candidate) => candidate.id !== agent.id))
    try {
      const response = await fetch('/api/agents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: agent.id }),
      })
      // Delete is owner-only, so a shared agent you don't own returns 404. Reporting
      // nothing made the UI look like it worked.
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        setAgents(previous)
        toast.error(data.error || 'Could not delete this agent — only its owner can.')
      }
    } catch {
      setAgents(previous)
      toast.error('Could not delete this agent — check your connection and try again.')
    }
    notifyAgentsChanged()
  }

  const dropProps = (key: string, target: { folder: string | null; share: 'org' | 'private' }) => ({
    // Sections are drop zones that CONTAIN folder drop zones, so both handlers
    // stop propagation — otherwise one drop on a folder would bubble up and
    // fire a second, conflicting move on the section.
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setDragOver(key)
    },
    onDragLeave: () => setDragOver((current) => (current === key ? null : current)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setDragOver(null)
      const agentId = event.dataTransfer.getData('text/agent-id')
      if (agentId) moveAgent(agentId, target).catch(() => undefined)
    },
  })

  const renderAgent = (agent: Agent) => (
    <div
      key={agent.id}
      draggable
      onDragStart={(event) => event.dataTransfer.setData('text/agent-id', agent.id)}
      className="group flex cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 text-muted-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground active:cursor-grabbing"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold uppercase leading-none text-muted-foreground">
        {agent.icon || agent.title.trim().charAt(0) || 'A'}
      </span>
      <button
        className="flex-1 truncate text-left text-sm"
        title={agent.description || agent.title}
        onClick={() => router.push(`/agents?agent=${agent.id}`)}
      >
        {agent.title}
      </button>
      <div className="hidden gap-0.5 group-hover:flex">
        <Button size="icon" variant="ghost" className="h-6 w-6 text-foreground hover:bg-muted" disabled={runningId === agent.id} onClick={() => runAgent(agent)} aria-label="Run agent">
          {runningId === agent.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
        </Button>
        <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive/70 hover:bg-muted hover:text-destructive" onClick={() => deleteAgent(agent)} aria-label="Delete agent">
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <div className="fixed left-4 top-4 z-50 lg:hidden">
        <Button variant="outline" size="icon" onClick={() => setMobileOpen(true)} className="border-border bg-background text-foreground shadow-2" aria-label="Open navigation">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </Button>
      </div>

      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border bg-background text-foreground transition-[width,transform] duration-200 lg:relative lg:translate-x-0',
          rail ? 'w-16' : 'w-72',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        {/* Org switcher */}
        <div className={cn('relative border-b border-border', rail ? 'p-2' : 'p-3')}>
          {rail ? (
            <div className="flex flex-col items-center gap-2">
              {/* The org dropdown can't fit in the rail — the logo expands instead. */}
              <RailTooltip label={activeOrg?.name || 'Workspace'}>
                <button
                  onClick={toggleCollapsed}
                  aria-label="Expand sidebar"
                  className="rounded-xl p-0.5 transition-colors duration-fast hover:bg-muted"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={activeOrg?.logoUrl || DEFAULT_ORG_LOGO}
                    alt=""
                    className="h-8 w-8 rounded-lg bg-white object-cover p-0.5 shadow-2 ring-1 ring-border"
                  />
                </button>
              </RailTooltip>
              <RailTooltip label="Expand sidebar" shortcut="⌘B">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Expand sidebar"
                  className="h-8 w-8 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={toggleCollapsed}
                >
                  <PanelLeft className="h-4 w-4" />
                </Button>
              </RailTooltip>
              <RailTooltip label="Search" shortcut="⌘K">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Search"
                  className="h-8 w-8 text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => setPaletteOpen(true)}
                >
                  <Search className="h-4 w-4" />
                </Button>
              </RailTooltip>
              <NotificationBell buttonClassName="border-border bg-muted text-foreground hover:bg-secondary" />
              <RailTooltip label="Send feedback">
                <Button variant="outline" size="icon" aria-label="Send feedback" className="h-8 w-8 border-border bg-muted" onClick={() => setFeedbackOpen(true)}>
                  <MessageSquarePlus className="h-4 w-4" />
                </Button>
              </RailTooltip>
            </div>
          ) : (
            <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex w-full min-w-0 items-center gap-2 rounded-xl px-2 py-1.5 transition-colors duration-fast hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Workspace: ${activeOrg?.name || 'Workspace'}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={activeOrg?.logoUrl || DEFAULT_ORG_LOGO}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-lg bg-white object-cover p-0.5 shadow-2 ring-1 ring-border"
                />
                <span className="min-w-0 flex-1 truncate text-left text-sm font-semibold">{activeOrg?.name || 'Workspace'}</span>
                <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={6} className="w-[16.5rem]">
                {/* Membership is single-workspace today, so workspace rows are
                    a plain listing — no click affordance that goes nowhere.
                    When multi-workspace membership lands, these become real
                    switch targets. */}
                {organizations.map((org) => (
                  <div
                    key={org.id}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={org.logoUrl || DEFAULT_ORG_LOGO} alt="" className="h-5 w-5 rounded object-cover" />
                    <span className="flex-1 truncate text-left">{org.name}</span>
                    <span className="text-xs text-muted-foreground">{planLabel(org.plan)}</span>
                    {org.id === activeOrg?.id && <Check className="h-4 w-4 text-foreground" />}
                  </div>
                ))}
                {/* Logo management PATCHes /api/organizations, which is
                    admin-only (403 for members) — don't offer it to non-admins. */}
                {isAdmin && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={uploadingLogo}
                      onSelect={() => logoInputRef.current?.click()}
                    >
                      {uploadingLogo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                      {activeOrg?.logoUrl ? 'Change workspace logo' : 'Upload workspace logo'}
                    </DropdownMenuItem>
                    {activeOrg?.logoUrl && (
                      <DropdownMenuItem
                        disabled={uploadingLogo}
                        onSelect={() => saveOrgLogo(null)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Remove logo
                      </DropdownMenuItem>
                    )}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="truncate font-normal">{user?.emailAddress}</DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={() => signOut()}
                >
                  <LogOut className="h-3.5 w-3.5" /> Sign out
                </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {isAdmin && (
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) uploadOrgLogo(file)
              }}
            />
          )}

          <div className="mt-2 flex items-center gap-2">
            <button
              className="flex flex-1 items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-fast hover:bg-secondary hover:text-foreground"
              onClick={() => setPaletteOpen(true)}
            >
              <Search className="h-3.5 w-3.5" />
              <span className="flex-1 text-left">Search</span>
            </button>
            <NotificationBell buttonClassName="border-border bg-muted text-foreground hover:bg-secondary" />
            <Button variant="outline" size="icon" aria-label="Send feedback" title="Send feedback" className="h-8 w-8 shrink-0 border-border bg-muted" onClick={() => setFeedbackOpen(true)}>
              <MessageSquarePlus className="h-4 w-4" />
            </Button>
            <RailTooltip label="Collapse sidebar" shortcut="⌘B">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Collapse sidebar"
                className="hidden h-8 w-8 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground lg:inline-flex"
                onClick={toggleCollapsed}
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </RailTooltip>
          </div>
            </>
          )}
        </div>

        {/* Nav + agent tree */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <nav className="mb-2 space-y-0.5">
            {navigation.map((item) => {
              // Compare against the SCOPED href: once every surface carries a
              // /g/<scope> prefix, matching pathname against the bare href
              // never succeeds and no nav item ever highlights.
              const href = scopedNavHref(item.href)
              const isActive = pathname === href || (item.href !== '/dashboard' && pathname.startsWith(href))
              const link = (
                <Link
                  key={item.name}
                  href={href}
                  aria-label={item.name}
                  title={rail ? undefined : item.description}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg text-sm font-medium transition-colors duration-fast',
                    rail ? 'justify-center p-2' : 'px-2 py-1.5',
                    isActive ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <item.icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-foreground' : 'text-muted-foreground')} />
                  {!rail && item.name}
                </Link>
              )
              return rail ? (
                <RailTooltip key={item.name} label={item.name} description={item.description}>
                  {link}
                </RailTooltip>
              ) : (
                link
              )
            })}
          </nav>

          {/* The agent tree needs labels and drop targets — it only renders
              expanded. Sharing/moving agents is a deliberate act, so requiring
              the expanded state is fine. */}
          {!rail && (
            <>
          {/* The whole section — header AND folder list — is the drop zone, so a
              drop anywhere in it shares the agent (inner folder rows are nested
              zones that stop propagation and take precedence). */}
          <div
            className={cn('rounded-lg', dragOver === 'workspace' && 'bg-muted')}
            {...dropProps('workspace', { folder: null, share: 'org' })}
          >
          <div className="flex items-center justify-between px-2 pb-1 pt-3">
            <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Workspace</span>
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => router.push('/agents?agent=new')}
              aria-label="New agent"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          {/* Keep the section's footprint even when empty — otherwise PRIVATE
              slides up under the WORKSPACE header and its folders read as
              workspace folders, making a successful "move to private" look
              like nothing happened. */}
          {sections.workspace.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">Drag agents here to share them with your workspace.</p>
          )}
          {sections.workspace.map(([folder, folderAgents]) => {
            const key = `ws:${folder}`
            const isCollapsed = collapsed[key]
            const isGeneral = folder === 'General'
            return (
              <div key={key} className="mb-0.5">
                <button
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
                    dragOver === key && 'bg-muted',
                  )}
                  onClick={() => setCollapsed((current) => ({ ...current, [key]: !current[key] }))}
                  {...dropProps(key, { folder: isGeneral ? null : folder, share: 'org' })}
                >
                  {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="flex-1 truncate text-left">{folder}</span>
                  <span className="text-xs text-muted-foreground">{folderAgents.length}</span>
                </button>
                {!isCollapsed && <div className="ml-3 border-l border-border pl-1">{folderAgents.map(renderAgent)}</div>}
              </div>
            )
          })}
          </div>

          {/* Same section-wide drop zone: dropping anywhere in Private — the
              header, a folder, or the empty-state hint — makes the agent private. */}
          <div
            className={cn('rounded-lg', dragOver === 'private' && 'bg-muted')}
            {...dropProps('private', { folder: null, share: 'private' })}
          >
          <div className="flex items-center gap-1.5 px-2 pb-1 pt-3 font-mono text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            <Lock className="h-3 w-3" /> Private
          </div>
          {/* Indent private folders under the header so they read as INSIDE
              Private, not as more workspace folders. */}
          {sections.private.length > 0
            ? <div className="ml-2 border-l border-border pl-1">{sections.private.map(([folder, folderAgents]) => {
                const key = `pv:${folder}`
                const isCollapsed = collapsed[key]
                const isGeneral = folder === 'General'
                return (
                  <div key={key} className="mb-0.5">
                    <button
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
                        dragOver === key && 'bg-muted',
                      )}
                      onClick={() => setCollapsed((current) => ({ ...current, [key]: !current[key] }))}
                      {...dropProps(key, { folder: isGeneral ? null : folder, share: 'private' })}
                    >
                      {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="flex-1 truncate text-left">{folder}</span>
                      <span className="text-xs text-muted-foreground">{folderAgents.length}</span>
                    </button>
                    {!isCollapsed && <div className="ml-3 border-l border-border pl-1">{folderAgents.map(renderAgent)}</div>}
                  </div>
                )
              })}</div>
            : <p className="px-2 py-1 text-xs text-muted-foreground">Drag agents here to make them private.</p>}
          </div>
            </>
          )}
        </div>

        {/* Footer: usage + user */}
        <div className={cn('shrink-0 overflow-hidden border-t border-border', rail ? 'p-2' : 'p-3')}>
          {!rail && usage && (
            <div className="mb-2 rounded-xl border border-border/80 bg-muted/40 p-2.5">
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-1 ring-1 ring-border/70">
                  <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">Monthly usage</span>
                <span className="shrink-0 text-muted-foreground">{usage.exempt ? 'Unlimited' : `${creditPct}%`}</span>
              </div>
              {!usage.exempt && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background ring-1 ring-border/60">
                  <div className="h-full rounded-full bg-foreground transition-[width] duration-slow ease-out-quart" style={{ width: `${creditPct}%` }} aria-hidden="true" />
                </div>
              )}
            </div>
          )}
          {/* The user row IS the Settings entry point (not a nav item). */}
          {(() => {
          const settingsLink = (
          <Link
            href="/settings"
            aria-label="Open settings"
            className={cn(
              'group flex min-w-0 items-center gap-2.5 rounded-xl p-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              rail && 'justify-center p-1',
              pathname.startsWith('/settings') && 'bg-muted',
            )}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground ring-1 ring-border/80">
              {(user?.firstName || 'U').charAt(0).toUpperCase()}
            </div>
            {!rail && (
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{user?.firstName || 'Account'}</span>
                  {activeOrg && <Badge variant="secondary" className="max-w-20 shrink-0 truncate px-2 py-0 text-[10px] font-medium">{planLabel(activeOrg.plan)}</Badge>}
                </div>
                <div className="truncate text-xs text-muted-foreground">{user?.emailAddress}</div>
              </div>
            )}
            {!rail && <Settings className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:rotate-12 group-hover:text-foreground" aria-hidden="true" />}
          </Link>
          )
          return rail ? <RailTooltip label="Settings">{settingsLink}</RailTooltip> : settingsLink
          })()}
        </div>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </>
  )
}
