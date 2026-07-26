'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
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

type State = { goals: GoalSummary[]; impact: OrgImpact }

export default function GoalsPage() {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copilot, setCopilot] = useState<{
    draft: CopilotDraft
    notes: string[]
  } | null>(null)
  const [llmReady, setLlmReady] = useState(false)

  const load = useCallback(async () => {
    try {
      setError(null)
      const [goalsResponse, impactResponse, capabilitiesBody] = await Promise.all([
        fetch('/api/goals', { cache: 'no-store' }),
        fetch('/api/goals/impact', { cache: 'no-store' }),
        fetch('/api/system/capabilities', { cache: 'no-store' })
          .then(async (response) => (response.ok ? response.json() : {}))
          .catch(() => ({})),
      ])
      const [goalsBody, impactBody] = await Promise.all([
        goalsResponse.json(),
        impactResponse.json(),
      ])
      if (!goalsResponse.ok || !impactResponse.ok) {
        throw new Error(goalsBody.error || impactBody.error || 'Could not load goals.')
      }
      setState({ goals: goalsBody.goals, impact: impactBody.impact })
      setLlmReady(
        Boolean(
          capabilitiesBody.capabilities?.some(
            (capability: { key: string; configured: boolean }) =>
              (capability.key === 'model.anthropic' ||
                capability.key === 'model.qwen') &&
              capability.configured,
          ),
        ),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load goals.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const organizationGoals = state?.goals.filter((goal) => !goal.personal) ?? []
  const personalGoals = state?.goals.filter((goal) => goal.personal) ?? []

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

      {!state && !error && (
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
          action={<Button onClick={() => void load()}>Try again</Button>}
        />
      )}

      {state && (
        <>
          {/* Export stays reachable at zero goals — the report route renders a
              valid "no goals tracked yet" document by design. */}
          <div className="flex justify-end">
            <ExportRoiReport />
          </div>
          {state.goals.length > 0 && <ImpactStrip impact={state.impact} onSaved={load} />}
          {state.goals.length === 0 ? (
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
