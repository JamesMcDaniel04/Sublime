'use client'

import Link from 'next/link'
import { useCallback, useState } from 'react'
import { Plus, RefreshCw, Target } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { GoalCard } from '@/components/goals/goal-card'
import { GoalTemplateGallery } from '@/components/goals/goal-template-gallery'
import { GoalCopilot } from '@/components/goals/goal-copilot'
import { CopilotPreview } from '@/components/goals/copilot-preview'
import {
  ExportRoiReport,
  ImpactStrip,
  type OrgImpact,
} from '@/components/goals/impact-strip'
import type { GoalSummary } from '@/lib/types'
import type { CopilotDraft } from '@/lib/goals/copilot'
import { invalidateCachedJson, useCachedJson } from '@/lib/client/use-cached-json'

type GoalsResponse = { goals?: GoalSummary[] }
type ImpactResponse = { impact?: OrgImpact }
type CapabilitiesResponse = {
  capabilities?: { key: string; configured: boolean }[]
}

const GOALS_URL = '/api/goals'
const IMPACT_URL = '/api/goals/impact'

const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

export default function GoalsPage() {
  // Stale-while-revalidate: paint instantly from the client cache (warmed at
  // sign-in by the sidebar) and refresh in the background. The previous
  // fetch-on-mount pattern blocked every visit on a cold round-trip, and the
  // mutation sites were already invalidating these two URLs against a cache
  // nothing read.
  const goalsQuery = useCachedJson<GoalsResponse>(GOALS_URL)
  const impactQuery = useCachedJson<ImpactResponse>(IMPACT_URL)
  const capabilities = useCachedJson<CapabilitiesResponse>('/api/system/capabilities')
  const [copilot, setCopilot] = useState<{
    draft: CopilotDraft
    notes: string[]
  } | null>(null)

  const goals = goalsQuery.data?.goals
  const impact = impactQuery.data?.impact
  const failure = goalsQuery.error ?? impactQuery.error
  const error = failure ? messageOf(failure, 'Could not load goals.') : null

  // Capability probing is best-effort — a failure here hides the Copilot
  // entry point rather than breaking the page, exactly as before.
  const llmReady = Boolean(
    capabilities.data?.capabilities?.some(
      (capability) =>
        (capability.key === 'model.anthropic' || capability.key === 'model.qwen') &&
        capability.configured,
    ),
  )

  const reload = useCallback(async () => {
    // Drop the entries first so a retry or a settings save re-reads the
    // server rather than repainting the same stale response.
    invalidateCachedJson(GOALS_URL)
    invalidateCachedJson(IMPACT_URL)
    await Promise.all([goalsQuery.refresh(), impactQuery.refresh()])
  }, [goalsQuery, impactQuery])

  const organizationGoals = goals?.filter((goal) => !goal.personal) ?? []
  const personalGoals = goals?.filter((goal) => goal.personal) ?? []
  const ready = goals !== undefined && impact !== undefined

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Targets"
        icon={Target}
        title="Goals"
        description="Track the numbers that matter, catch risk early, and prove what your automations contributed."
        actions={
          <Button asChild>
            <Link href="/goals/new">
              <Plus className="mr-2 h-4 w-4" />
              New goal
            </Link>
          </Button>
        }
      />

      {copilot ? (
        <CopilotPreview
          draft={copilot.draft}
          notes={copilot.notes}
          onCancel={() => setCopilot(null)}
        />
      ) : (
        <>
          {llmReady && (
            <GoalCopilot
              onDraft={(draft, notes) => setCopilot({ draft, notes })}
            />
          )}

      {!ready && !error && (
        <div className="grid animate-pulse gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-32 rounded-2xl bg-muted" />
          ))}
        </div>
      )}

      {error && (
        <EmptyState
          icon={RefreshCw}
          title="Goals could not load"
          description={error}
          action={
            <Button
              onClick={() => {
                void reload()
              }}
            >
              Try again
            </Button>
          }
        />
      )}

      {ready && (
        <>
          {/* Export stays reachable at zero goals — the report route renders a
              valid "no goals tracked yet" document by design. */}
          <div className="flex justify-end">
            <ExportRoiReport />
          </div>
          {goals.length > 0 && <ImpactStrip impact={impact} onSaved={reload} />}
          {goals.length === 0 ? (
            <div className="space-y-8">
              <EmptyState
                icon={Target}
                title="Set your first goal"
                description="Set a goal and Sublime will track it, watch for risk, and recommend what to do about it."
                action={
                  <Button asChild>
                    <Link href="/goals/new">Create a goal</Link>
                  </Button>
                }
              />
              <GoalTemplateGallery />
            </div>
          ) : (
            <div className="space-y-8">
              <GoalTemplateGallery />
              {organizationGoals.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-lg font-semibold">Organization goals</h2>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {organizationGoals.map((goal) => (
                      <GoalCard key={goal.id} goal={goal} />
                    ))}
                  </div>
                </section>
              )}
              {personalGoals.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-lg font-semibold">My goals</h2>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {personalGoals.map((goal) => (
                      <GoalCard key={goal.id} goal={goal} />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </>
      )}
        </>
      )}
    </div>
  )
}
