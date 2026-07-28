'use client'

import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { TemplateCardShell } from '@/components/templates/template-card-shell'
import { CATEGORY_ACCENTS, CATEGORY_ICONS } from '@/components/goals/goal-template-accents'
import { SOURCE_LABELS } from '@/components/goals/source-labels'
import { SourceLogo } from '@/components/goals/source-logo'
import { bundleForGoal } from '@/lib/goals/agent-bundle'
import type { GoalTemplate } from '@/lib/goals/goal-templates'
import { cn } from '@/lib/utils'

const VISIBLE_SOURCES = 3

/**
 * A goal template in the catalogue grid. Same chrome as the agent and flow
 * cards, but it renders a button rather than a link — clicking opens the
 * detail dialog, it does not create anything.
 */
export function GoalTemplateCard({
  template,
  connectedSources,
  onOpen,
}: {
  template: GoalTemplate
  /** Metric sources the workspace has a working connection for. */
  connectedSources: Set<string>
  onOpen: (template: GoalTemplate) => void
}) {
  const accent = CATEGORY_ACCENTS[template.category]
  const shown = template.sources.slice(0, VISIBLE_SOURCES)
  const overflow = template.sources.length - shown.length
  // Same signal the agent catalogue card carries: a filled CTA when the
  // workspace can already feed this template, an outline one when it would
  // start on manual entry. `manual` is excluded — it is always available, so
  // counting it would make every card look connected.
  const ready = template.sources.some(
    (source) => source !== 'manual' && connectedSources.has(source),
  )
  // source: null — the metric source is chosen later in the wizard, so this
  // counts the agents any goal from this template could run. Memoized because
  // the gallery renders a grid of these and each call scans the seed catalogue.
  const agentCount = useMemo(
    () =>
      bundleForGoal({
        templateKey: template.key,
        kind: template.kind,
        source: null,
        recurrence: template.recurrence,
      }).length,
    [template.key, template.kind, template.recurrence],
  )

  return (
    <button
      type="button"
      onClick={() => onOpen(template)}
      aria-haspopup="dialog"
      className="block h-full w-full rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <TemplateCardShell
        accent={accent}
        icon={CATEGORY_ICONS[template.category]}
        title={template.name}
        description={template.description}
        badges={
          <>
            <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>
              {template.category}
            </Badge>
            <Badge variant={template.scope === 'org' ? 'secondary' : 'outline'} className="text-[11px] font-medium">
              {template.scope === 'org' ? 'Org' : 'Personal'}
            </Badge>
            {template.recurrence && (
              <Badge variant="outline" className="text-[11px] font-medium">
                ↻ {template.recurrence}
              </Badge>
            )}
          </>
        }
        tools={
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Reads from</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {shown.map((source) => (
                <span
                  key={source}
                  data-connected={connectedSources.has(source)}
                  className={cn(!connectedSources.has(source) && 'opacity-55')}
                >
                  <IntegrationChip
                    name={SOURCE_LABELS[source] ?? source}
                    logo={<SourceLogo source={source} className="h-4 w-4" />}
                  />
                </span>
              ))}
              {overflow > 0 && (
                <span className="text-xs font-medium text-muted-foreground">+{overflow}</span>
              )}
            </div>
            {agentCount > 0 && (
              <p className="text-xs font-medium text-muted-foreground">
                {agentCount} {agentCount === 1 ? 'agent' : 'agents'} work on it
              </p>
            )}
          </div>
        }
        cta={
          <Button size="sm" variant={ready ? 'default' : 'outline'} className="w-full" asChild>
            <span>View goal</span>
          </Button>
        }
      />
    </button>
  )
}
