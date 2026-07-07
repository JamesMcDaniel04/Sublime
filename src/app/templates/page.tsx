'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import {
  Sparkles, TrendingUp, CalendarClock, ShieldAlert, Target,
  Inbox, LineChart, Bell, Plus,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Pagination, paginate } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { cn } from '@/lib/utils'

/** Cards per page on the Templates and Skills grids. */
const PAGE_SIZE = 9

interface TemplateItem {
  id: string
  name: string
  description: string
  category: string
  integrations?: string[]
  tags?: string[]
  version?: string
}

interface SkillItem {
  id: string
  name: string
  description: string
  category: string
  audience: string[]
  tags: string[]
  integrations: string[]
}

interface AgentItem {
  id: string
  title: string
  skills: string[]
}

// ── Card styling helpers ──────────────────────────────────────────────────
// A small palette of accents; a category is deterministically hashed to one so
// the same category always gets the same color, but cards stay varied and alive.
const ACCENTS = [
  { bar: 'from-sky-500 to-cyan-400',       tile: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',           badge: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300',           ring: 'hover:ring-sky-300/70 dark:hover:ring-sky-500/40' },
  { bar: 'from-violet-500 to-fuchsia-400', tile: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300', badge: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300', ring: 'hover:ring-violet-300/70 dark:hover:ring-violet-500/40' },
  { bar: 'from-emerald-500 to-teal-400',   tile: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300', badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300', ring: 'hover:ring-emerald-300/70 dark:hover:ring-emerald-500/40' },
  { bar: 'from-amber-500 to-orange-400',   tile: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',     badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',     ring: 'hover:ring-amber-300/70 dark:hover:ring-amber-500/40' },
  { bar: 'from-rose-500 to-pink-400',      tile: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',         badge: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',         ring: 'hover:ring-rose-300/70 dark:hover:ring-rose-500/40' },
  { bar: 'from-indigo-500 to-blue-400',    tile: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300', badge: 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300', ring: 'hover:ring-indigo-300/70 dark:hover:ring-indigo-500/40' },
] as const

function hashIndex(seed: string, mod: number): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h % mod
}

function accentFor(category: string) {
  return ACCENTS[hashIndex(category || 'default', ACCENTS.length)]
}

function categoryIcon(category: string) {
  const c = (category || '').toLowerCase()
  if (c.includes('meet')) return CalendarClock
  if (c.includes('risk') || c.includes('monitor') || c.includes('contract')) return ShieldAlert
  if (c.includes('forecast')) return LineChart
  if (c.includes('pipeline') || c.includes('discov') || c.includes('opportun')) return Target
  if (c.includes('inbox') || c.includes('productiv') || c.includes('exec')) return Inbox
  if (c.includes('sales') || c.includes('digest') || c.includes('revenue')) return TrendingUp
  if (c.includes('alert') || c.includes('notif') || c.includes('signal')) return Bell
  return Sparkles
}

function ExplorePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const activeTab = searchParams.get('tab') === 'skills' ? 'skills' : 'templates'

  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [agents, setAgents] = useState<AgentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Card grids cap at 9 per page; each tab pages independently.
  const [templatesPage, setTemplatesPage] = useState(1)
  const [skillsPage, setSkillsPage] = useState(1)
  // Track which skill's dropdown is open
  const [openSkillMenu, setOpenSkillMenu] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const handleTabChange = (value: string) => {
    router.replace(value === 'skills' ? '/templates?tab=skills' : '/templates', { scroll: false })
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [templatesRes, skillsRes, agentsRes] = await Promise.all([
          fetch('/api/agent-templates', { cache: 'no-store' }),
          fetch('/api/skills', { cache: 'no-store' }),
          fetch('/api/agents', { cache: 'no-store' }),
        ])
        if (!templatesRes.ok) throw new Error(`Templates fetch failed: status ${templatesRes.status}`)
        const [templatesData, skillsData, agentsData] = await Promise.all([
          templatesRes.json(),
          skillsRes.ok ? skillsRes.json() : { success: false, skills: [] },
          agentsRes.ok ? agentsRes.json() : { success: false, agents: [] },
        ])
        if (cancelled) return
        setTemplates(templatesData.templates || [])
        setSkills(skillsData.success ? skillsData.skills : [])
        setAgents(agentsData.success ? agentsData.agents : [])
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load templates')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!openSkillMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenSkillMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [openSkillMenu])

  const addSkillToAgent = async (skill: SkillItem, agent: AgentItem) => {
    setOpenSkillMenu(null)
    const updatedSkills = Array.from(new Set([...(agent.skills || []), skill.id]))
    try {
      const res = await fetch('/api/agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: agent.id, skills: updatedSkills }),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      // Update local agent list so subsequent "add" operations see the latest skills
      setAgents((prev) =>
        prev.map((a) => a.id === agent.id ? { ...a, skills: updatedSkills } : a)
      )
      toast.success(`Added "${skill.name}" to ${agent.title}`)
    } catch {
      toast.error(`Failed to add skill to ${agent.title}`)
    }
  }

  if (loading || error) {
    return (
      <>
        <div className="max-w-6xl mx-auto p-6 space-y-6">
          <PageHeader eyebrow="Library" title="Explore" />
          {loading && (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
              <Skeleton className="h-56 rounded-xl" />
              <Skeleton className="h-56 rounded-xl" />
              <Skeleton className="h-56 rounded-xl" />
              <Skeleton className="h-56 rounded-xl" />
              <Skeleton className="h-56 rounded-xl" />
              <Skeleton className="h-56 rounded-xl" />
            </div>
          )}
          {error && <p className="text-red-500">{error}</p>}
        </div>
      </>
    )
  }

  return (
    <>
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <PageHeader eyebrow="Library" title="Explore" />

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="templates">Templates</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
          </TabsList>

          {/* ── Templates tab ─────────────────────────────────────────────── */}
          <TabsContent value="templates" className="mt-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">Templates</h2>
              <p className="text-sm text-muted-foreground">Single-task and enhanced templates</p>
            </div>

            {templates.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="No templates available yet"
                description="Templates published to your workspace appear here."
              />
            ) : (
              <div className="stagger-children grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {paginate(templates, templatesPage, PAGE_SIZE).pageItems.map((t) => {
                  const accent = accentFor(t.category)
                  const Icon = categoryIcon(t.category)
                  return (
                    <Link key={t.id} href={`/templates/${t.id}`} className="block">
                      <Card className={cn(
                        'group relative h-full overflow-hidden border-border/60 transition-all duration-200',
                        'hover:-translate-y-0.5 hover:shadow-lg hover:ring-1',
                        accent.ring,
                      )}>
                        {/* colored accent bar that brightens on hover */}
                        <div className={cn('absolute inset-x-0 top-0 h-1 bg-gradient-to-r opacity-80 transition-opacity group-hover:opacity-100', accent.bar)} />
                        <CardHeader className="space-y-2.5 pt-5">
                          <div>
                            <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>{t.category}</Badge>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105', accent.tile)}>
                              <Icon className="h-[18px] w-[18px]" />
                            </span>
                            <CardTitle className="min-w-0 text-base leading-snug">{t.name}</CardTitle>
                          </div>
                          {t.tags && t.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {t.tags.slice(0, 3).map(tag => (
                                <Badge key={tag} variant="outline" className="text-xs text-muted-foreground">{tag}</Badge>
                              ))}
                            </div>
                          )}
                        </CardHeader>
                        <CardContent className="space-y-3">
                          <p className="text-sm text-muted-foreground line-clamp-3">{t.description}</p>
                          {t.integrations && t.integrations.length > 0 && (
                            <div className="space-y-1.5">
                              <p className="text-xs font-medium text-muted-foreground">Requires</p>
                              <div className="flex flex-wrap gap-1.5">
                                {t.integrations.map((i) => (
                                  <IntegrationChip key={i} name={i} />
                                ))}
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </Link>
                  )
                })}
              </div>
            )}
            <Pagination
              page={paginate(templates, templatesPage, PAGE_SIZE).page}
              pageCount={paginate(templates, templatesPage, PAGE_SIZE).pageCount}
              onPageChange={setTemplatesPage}
            />
          </TabsContent>

          {/* ── Skills tab ────────────────────────────────────────────────── */}
          <TabsContent value="skills" className="mt-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">Skills</h2>
              <p className="text-sm text-muted-foreground">Instruction packs that extend agents at run time</p>
            </div>

            {skills.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="No skills available yet"
                description="Skills published to your workspace appear here."
              />
            ) : (
              <div className="stagger-children grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {paginate(skills, skillsPage, PAGE_SIZE).pageItems.map((skill) => {
                  const accent = accentFor(skill.category)
                  const Icon = categoryIcon(skill.category)
                  return (
                  <Card key={skill.id} className={cn(
                    'group relative h-full flex flex-col overflow-hidden border-border/60 transition-all duration-200',
                    'hover:-translate-y-0.5 hover:shadow-lg hover:ring-1',
                    accent.ring,
                  )}>
                    <div className={cn('absolute inset-x-0 top-0 h-1 bg-gradient-to-r opacity-80 transition-opacity group-hover:opacity-100', accent.bar)} />
                    <CardHeader className="space-y-2.5 pt-5">
                      <div>
                        <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>{skill.category}</Badge>
                      </div>
                      <div className="flex items-start gap-2.5">
                        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105', accent.tile)}>
                          <Icon className="h-[18px] w-[18px]" />
                        </span>
                        <CardTitle className="min-w-0 text-base leading-snug">{skill.name}</CardTitle>
                      </div>
                      {skill.tags && skill.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {skill.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag} variant="outline" className="text-xs text-muted-foreground">{tag}</Badge>
                          ))}
                        </div>
                      )}
                    </CardHeader>
                    <CardContent className="flex flex-col flex-1 space-y-3">
                      <p className="text-sm text-muted-foreground line-clamp-3 flex-1">{skill.description}</p>

                      {skill.integrations && skill.integrations.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {skill.integrations.map((i) => (
                            <IntegrationChip key={i} name={i} />
                          ))}
                        </div>
                      )}

                      {/* Add to agent control */}
                      <div className="relative" ref={openSkillMenu === skill.id ? menuRef : null}>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={() => {
                            if (agents.length === 0) {
                              toast('Create an agent first before adding skills.')
                              return
                            }
                            setOpenSkillMenu(openSkillMenu === skill.id ? null : skill.id)
                          }}
                        >
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          Add to agent
                        </Button>

                        {openSkillMenu === skill.id && agents.length > 0 && (
                          <div className="absolute bottom-full left-0 right-0 mb-1 z-50 origin-bottom animate-scale-in rounded-md border border-border bg-popover shadow-popover">
                            <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground font-medium">Select an agent</p>
                            <ul className="max-h-48 overflow-y-auto pb-1">
                              {agents.map((agent) => (
                                <li key={agent.id}>
                                  <button
                                    type="button"
                                    className="w-full px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
                                    onClick={() => addSkillToAgent(skill, agent)}
                                  >
                                    {agent.title}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                  )
                })}
              </div>
            )}
            <Pagination
              page={paginate(skills, skillsPage, PAGE_SIZE).page}
              pageCount={paginate(skills, skillsPage, PAGE_SIZE).pageCount}
              onPageChange={setSkillsPage}
            />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}

export default function TemplatesIndexPage() {
  return (
    <Suspense fallback={null}>
      <ExplorePage />
    </Suspense>
  )
}
