import Link from 'next/link'
import { Bell, CalendarClock, Inbox, LineChart, ShieldAlert, Sparkles, Target, TrendingUp, Workflow } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { cn } from '@/lib/utils'

const ACCENTS = [
  { bar: 'from-sky-500 to-cyan-400', tile: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300', badge: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300', ring: 'hover:ring-sky-300/70 dark:hover:ring-sky-500/40' },
  { bar: 'from-violet-500 to-fuchsia-400', tile: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300', badge: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300', ring: 'hover:ring-violet-300/70 dark:hover:ring-violet-500/40' },
  { bar: 'from-emerald-500 to-teal-400', tile: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300', badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300', ring: 'hover:ring-emerald-300/70 dark:hover:ring-emerald-500/40' },
  { bar: 'from-amber-500 to-orange-400', tile: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300', badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300', ring: 'hover:ring-amber-300/70 dark:hover:ring-amber-500/40' },
  { bar: 'from-rose-500 to-pink-400', tile: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300', badge: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300', ring: 'hover:ring-rose-300/70 dark:hover:ring-rose-500/40' },
  { bar: 'from-indigo-500 to-blue-400', tile: 'bg-indigo-100 text-indigo-600', badge: 'border-indigo-200 bg-indigo-50 text-indigo-700', ring: 'hover:ring-indigo-300/70' },
] as const

function hashIndex(seed: string, mod: number): number {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0
  return hash % mod
}

function accentFor(category: string) {
  return ACCENTS[hashIndex(category || 'default', ACCENTS.length)]
}

function categoryIcon(category: string, kind: 'agent' | 'flow') {
  if (kind === 'flow') return Workflow
  const normalized = category.toLowerCase()
  if (normalized.includes('meet')) return CalendarClock
  if (normalized.includes('risk') || normalized.includes('monitor') || normalized.includes('contract')) return ShieldAlert
  if (normalized.includes('forecast')) return LineChart
  if (normalized.includes('pipeline') || normalized.includes('discov') || normalized.includes('opportun')) return Target
  if (normalized.includes('inbox') || normalized.includes('productiv') || normalized.includes('exec')) return Inbox
  if (normalized.includes('sales') || normalized.includes('digest') || normalized.includes('revenue')) return TrendingUp
  if (normalized.includes('alert') || normalized.includes('notif') || normalized.includes('signal')) return Bell
  return Sparkles
}

type TemplateCatalogueCardProps = {
  href: string
  name: string
  description: string
  category: string
  integrations: readonly string[]
  kind?: 'agent' | 'flow'
  missingIntegrations?: readonly string[]
  actionLabel?: string
}

/** The canonical catalogue card shared by agent and flow starters. */
export function TemplateCatalogueCard({
  href,
  name,
  description,
  category,
  integrations,
  kind = 'agent',
  missingIntegrations = [],
  actionLabel = 'Use template',
}: TemplateCatalogueCardProps) {
  const accent = accentFor(category)
  const Icon = categoryIcon(category, kind)

  return (
    <Link href={href} className="block h-full">
      <Card className={cn(
        'group relative h-full overflow-hidden border-border/60 transition-all duration-200',
        'hover:-translate-y-0.5 hover:shadow-lg hover:ring-1',
        accent.ring,
      )}>
        <div className={cn('absolute inset-x-0 top-0 h-1 bg-gradient-to-r opacity-80 transition-opacity group-hover:opacity-100', accent.bar)} />
        <CardHeader className="space-y-2.5 pt-5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>{category}</Badge>
            {kind === 'flow' && <Badge variant="outline" className="text-[11px] font-medium">Flow</Badge>}
          </div>
          <div className="flex items-start gap-2.5">
            <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105', accent.tile)}>
              <Icon className="h-[18px] w-[18px]" />
            </span>
            <CardTitle className="min-w-0 text-base leading-snug">{name}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="line-clamp-3 text-sm text-muted-foreground">{description}</p>
          {integrations.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Requires</p>
              <div className="flex flex-wrap gap-1.5">
                {integrations.map((integration) => (
                  <span key={integration} className={cn(missingIntegrations.includes(integration) && 'saturate-150')}>
                    <IntegrationChip name={integration} />
                  </span>
                ))}
              </div>
            </div>
          )}
          <Button size="sm" variant={missingIntegrations.length > 0 ? 'outline' : 'default'} className="w-full" asChild>
            <span>{actionLabel}</span>
          </Button>
        </CardContent>
      </Card>
    </Link>
  )
}
