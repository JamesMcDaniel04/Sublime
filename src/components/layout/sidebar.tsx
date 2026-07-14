'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  FileText,
  Folder,
  ImagePlus,
  Loader2,
  Lock,
  LogOut,
  Play,
  Plug,
  Plus,
  Search,
  Trash2,
  Workflow,
} from 'lucide-react'
import { toast } from 'sonner'
import { CommandPalette } from '@/components/search/command-palette'
import { NotificationBell } from '@/components/notifications/notification-bell'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/use-auth'
import { getSnapshot, scopeSnapshot } from '@/lib/client/snapshot'
import { prefetchCachedJson, scopeCachedJson } from '@/lib/client/use-cached-json'
import { cn } from '@/lib/utils'
import type { Agent as AgentType } from '@/lib/types'

type Agent = Pick<AgentType, 'id' | 'title' | 'description' | 'instructions' | 'icon' | 'folder' | 'visibility'>

type Organization = { id: string; name: string; slug: string; plan: string; logoUrl?: string | null }

/** Default workspace avatar — the Sublime mark, until an org uploads its own. */
const DEFAULT_ORG_LOGO = '/sublime-mark-blue.svg'

/**
 * Downscale an uploaded image to a small square PNG data URL so the logo can
 * be stored inline (no object storage) and still render crisply at 32px.
 */
function resizeImageToDataUrl(file: File, size = 128): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const context = canvas.getContext('2d')
      if (!context) return reject(new Error('Canvas unavailable'))
      // Cover-fit: crop the shorter axis so logos stay centered and square.
      const scale = Math.max(size / image.width, size / image.height)
      const width = image.width * scale
      const height = image.height * scale
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read that image'))
    }
    image.src = url
  })
}
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
export const AGENTS_CHANGED_EVENT = 'sublime:agents-changed'

export function notifyAgentsChanged() {
  window.dispatchEvent(new CustomEvent(AGENTS_CHANGED_EVENT))
}

const navigation = [
  { name: 'Home', href: '/dashboard', icon: Brain },
  { name: 'Integrations', href: '/integrations', icon: Plug },
  { name: 'Flows', href: '/flows', icon: Workflow },
  { name: 'Templates', href: '/templates', icon: FileText },
]

function planLabel(plan: string) {
  const lower = plan.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { user, signOut } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [orgMenuOpen, setOrgMenuOpen] = useState(false)
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
    const timer = window.setTimeout(() => {
      prefetchCachedJson([
        '/api/agent-templates',
        '/api/skills',
        '/api/agents',
        '/api/flows',
        '/api/integrations/available',
        '/api/nango/integrations',
        '/api/nango/status',
        '/api/mcp-connections',
      ])
    }, 250)
    return () => window.clearTimeout(timer)
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
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  const activeOrg = organizations.find((org) => org.id === activeOrgId) || organizations[0] || null

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
    const shared = agents.filter((agent) => agent.visibility !== 'private')
    const folders = new Map<string, Agent[]>()
    for (const agent of shared) {
      const key = agent.folder?.trim() || 'General'
      const bucket = folders.get(key)
      if (bucket) bucket.push(agent)
      else folders.set(key, [agent])
    }
    return {
      workspace: [...folders.entries()].sort(([a], [b]) => a.localeCompare(b)),
      private: agents.filter((agent) => agent.visibility === 'private'),
    }
  }, [agents])

  const creditPct = usage ? Math.min(100, Math.round(((usage.inputTokens + usage.outputTokens) / CREDIT_TOKENS) * 100)) : 0

  const moveAgent = async (agentId: string, target: { folder: string | null; visibility: 'shared' | 'private' }) => {
    const agent = agents.find((candidate) => candidate.id === agentId)
    if (!agent) return
    if ((agent.folder || null) === target.folder && agent.visibility === target.visibility) return
    await fetch('/api/agents', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agentId, folder: target.folder, visibility: target.visibility }),
    })
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
        router.push('/dashboard')
      } else {
        toast.error(data.error || 'Run failed')
      }
    } finally {
      setRunningId(null)
    }
  }

  const deleteAgent = async (agent: Agent) => {
    await fetch('/api/agents', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agent.id }),
    })
    notifyAgentsChanged()
  }

  const dropProps = (key: string, target: { folder: string | null; visibility: 'shared' | 'private' }) => ({
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault()
      setDragOver(key)
    },
    onDragLeave: () => setDragOver((current) => (current === key ? null : current)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault()
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
      className="group flex cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 text-[#C0D5D5] transition-colors duration-fast hover:bg-white/10 hover:text-white active:cursor-grabbing"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/10 text-[11px] font-semibold uppercase leading-none text-[#FFD6C4]">
        {agent.icon || agent.title.trim().charAt(0) || 'A'}
      </span>
      <button
        className="flex-1 truncate text-left text-sm"
        title={agent.description || agent.title}
        onClick={() => router.push(`/dashboard?agent=${agent.id}`)}
      >
        {agent.title}
      </button>
      <div className="hidden gap-0.5 group-hover:flex">
        <Button size="icon" variant="ghost" className="h-6 w-6 text-white hover:bg-white/10 hover:text-white" disabled={runningId === agent.id} onClick={() => runAgent(agent)} aria-label="Run agent">
          {runningId === agent.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
        </Button>
        <Button size="icon" variant="ghost" className="h-6 w-6 text-[#FFB08D] hover:bg-white/10 hover:text-[#FFD6C4]" onClick={() => deleteAgent(agent)} aria-label="Delete agent">
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-[#062F33]/60 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <div className="fixed left-4 top-4 z-50 lg:hidden">
        <Button variant="outline" size="icon" onClick={() => setMobileOpen(true)} className="border-[#062F33]/10 bg-white text-[#062F33] shadow-brand" aria-label="Open navigation">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </Button>
      </div>

      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-white/10 bg-gradient-sublime text-white shadow-[12px_0_40px_rgba(6,47,51,0.08)] transition-transform duration-200 lg:relative lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        {/* Org switcher */}
        <div className="relative border-b border-white/10 p-3">
          <button
            className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 transition-colors duration-fast hover:bg-white/10"
            onClick={() => setOrgMenuOpen((open) => !open)}
            aria-label={`Workspace: ${activeOrg?.name || 'Workspace'}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={activeOrg?.logoUrl || DEFAULT_ORG_LOGO}
              alt=""
              className="h-8 w-8 rounded-lg bg-white object-cover p-0.5 shadow-2 ring-1 ring-white/20"
            />
            <span className="flex-1 truncate text-left text-sm font-semibold">{activeOrg?.name || 'Workspace'}</span>
            <ChevronsUpDown className="h-4 w-4 text-[#9DC9C2]" />
          </button>
          {orgMenuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOrgMenuOpen(false)} />
              <div className="absolute left-3 right-3 z-20 mt-1 origin-top animate-scale-in rounded-xl border bg-white p-1 text-[#062F33] shadow-popover">
                {organizations.map((org) => (
                  <button
                    key={org.id}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-gray-100"
                    onClick={() => setOrgMenuOpen(false)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={org.logoUrl || DEFAULT_ORG_LOGO} alt="" className="h-5 w-5 rounded object-cover" />
                    <span className="flex-1 truncate text-left">{org.name}</span>
                    <span className="text-xs text-gray-400">{planLabel(org.plan)}</span>
                    {org.id === activeOrg?.id && <Check className="h-4 w-4 text-indigo-600" />}
                  </button>
                ))}
                <div className="my-1 border-t" />
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                  disabled={uploadingLogo}
                  onClick={() => logoInputRef.current?.click()}
                >
                  {uploadingLogo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                  {activeOrg?.logoUrl ? 'Change workspace logo' : 'Upload workspace logo'}
                </button>
                {activeOrg?.logoUrl && (
                  <button
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                    disabled={uploadingLogo}
                    onClick={() => saveOrgLogo(null)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove logo
                  </button>
                )}
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
                <div className="my-1 border-t" />
                <div className="truncate px-2 py-1 text-xs text-gray-400">{user?.emailAddress}</div>
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                  onClick={signOut}
                >
                  <LogOut className="h-3.5 w-3.5" /> Sign out
                </button>
              </div>
            </>
          )}

          <div className="mt-2 flex items-center gap-2">
            <button
              className="flex flex-1 items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-sm text-[#B9D3D2] transition-colors duration-fast hover:border-white/30 hover:bg-white/15 hover:text-white"
              onClick={() => setPaletteOpen(true)}
            >
              <Search className="h-3.5 w-3.5" />
              <span className="flex-1 text-left">Search</span>
              <kbd className="rounded border border-white/10 bg-white/10 px-1.5 py-0.5 text-[10px] text-[#9DC9C2]">⌘K</kbd>
            </button>
            <NotificationBell buttonClassName="border-white/15 bg-white/10 text-white hover:border-white/30 hover:bg-white/15 hover:text-white" />
          </div>
        </div>

        {/* Nav + agent tree */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <nav className="mb-2 space-y-0.5">
            {navigation.map((item) => {
              const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors duration-fast',
                    isActive ? 'bg-[#FFF0E8] text-[#062F33] shadow-2' : 'text-[#C0D5D5] hover:bg-white/10 hover:text-white',
                  )}
                >
                  <item.icon className={cn('h-4 w-4', isActive ? 'text-[#E95725]' : 'text-[#7DACA8]')} />
                  {item.name}
                </Link>
              )
            })}
          </nav>

          <div
            className={cn(
              'flex items-center justify-between rounded-lg px-2 pb-1 pt-3',
              dragOver === 'workspace' && 'bg-white/10',
            )}
            {...dropProps('workspace', { folder: null, visibility: 'shared' })}
          >
            <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-[#7DACA8]">Workspace</span>
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 text-[#B9D3D2] hover:bg-white/10 hover:text-white"
              onClick={() => router.push('/dashboard?agent=new')}
              aria-label="New agent"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          {sections.workspace.map(([folder, folderAgents]) => {
            const key = `ws:${folder}`
            const isCollapsed = collapsed[key]
            const isGeneral = folder === 'General'
            return (
              <div key={key} className="mb-0.5">
                <button
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-[#C0D5D5] hover:bg-white/10 hover:text-white',
                    dragOver === key && 'bg-white/10',
                  )}
                  onClick={() => setCollapsed((current) => ({ ...current, [key]: !current[key] }))}
                  {...dropProps(key, { folder: isGeneral ? null : folder, visibility: 'shared' })}
                >
                  {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  <Folder className="h-3.5 w-3.5 text-[#7DACA8]" />
                  <span className="flex-1 truncate text-left">{folder}</span>
                  <span className="text-xs text-[#7DACA8]">{folderAgents.length}</span>
                </button>
                {!isCollapsed && <div className="ml-3 border-l border-white/10 pl-1">{folderAgents.map(renderAgent)}</div>}
              </div>
            )
          })}

          <div
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-2 pb-1 pt-3 font-mono text-[11px] font-bold uppercase tracking-wider text-[#7DACA8]',
              dragOver === 'private' && 'bg-white/10',
            )}
            {...dropProps('private', { folder: null, visibility: 'private' })}
          >
            <Lock className="h-3 w-3" /> Private
          </div>
          {sections.private.length > 0
            ? <div className="ml-3 border-l border-white/10 pl-1">{sections.private.map(renderAgent)}</div>
            : <p className="px-2 py-1 text-xs text-[#7DACA8]">Drag agents here to make them private.</p>}
        </div>

        {/* Footer: usage + user */}
        <div className="border-t border-white/10 p-3">
          {usage && (
            <div className="mb-2 px-1">
              <div className="mb-1 flex justify-between text-xs text-[#9DC9C2]">
                <span>Usage this month</span>
                <span>{usage.exempt ? 'Unlimited' : `${creditPct}% of credits`}</span>
              </div>
              {!usage.exempt && (
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-[#FF6B35] transition-[width] duration-slow ease-out-quart" style={{ width: `${creditPct}%` }} />
                </div>
              )}
            </div>
          )}
          {/* The user row IS the Settings entry point (not a nav item). */}
          <Link
            href="/settings"
            aria-label="Open settings"
            className={cn(
              'flex items-center gap-2 rounded-xl px-1 py-1 transition-colors hover:bg-white/10',
              pathname.startsWith('/settings') && 'bg-white/10',
            )}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#FFF0E8] text-xs font-semibold text-[#BE3F18]">
              {(user?.firstName || 'U').charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{user?.firstName || 'Account'}</div>
              <div className="truncate text-xs text-[#7DACA8]">{user?.emailAddress}</div>
            </div>
            {activeOrg && (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-[#B9D3D2]">{planLabel(activeOrg.plan)}</span>
            )}
          </Link>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </>
  )
}
