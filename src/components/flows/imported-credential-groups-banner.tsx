'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, KeyRound } from 'lucide-react'
import type { CredentialGroup } from '@/lib/import/types'
import type { FlowGraph } from '@/lib/flows/graph'
import { CredentialPicker } from '@/components/credentials/credential-picker'
import { groupDraftSeed } from './import-flow-dialog'

/**
 * The "bind credentials later" affordance the import dialog promises:
 * `Flow.metadata.importedCredentialGroups` is persisted at import time, and
 * this banner resurfaces any group whose member HTTP steps still lack a
 * credential — closing the dialog no longer strands the bulk-bind.
 *
 * "Outstanding" is derived from the LIVE graph rather than a bound-flag in
 * metadata, so binding through this banner, the import dialog, or a step's
 * own auth section all retire the group identically.
 */
export function ImportedCredentialGroupsBanner({
  groups,
  graph,
  onBind,
}: Readonly<{
  groups: CredentialGroup[]
  graph: FlowGraph
  /** Patch every member step with the chosen vault credential (local graph
   *  mutation — saving rides the builder's normal save/undo machinery). */
  onBind: (group: CredentialGroup, credentialId: string, credentialType: string) => void
}>) {
  const [collapsed, setCollapsed] = useState(false)
  const outstanding = useMemo(
    () =>
      groups.filter((group) => {
        if (group.unsupported || !group.credentialType) return false
        return graph.nodes.some(
          (node) =>
            group.nodeIds.includes(node.id)
            && node.type === 'http'
            && !(node.data as { credentialId?: string }).credentialId?.trim(),
        )
      }),
    [groups, graph],
  )
  if (outstanding.length === 0) return null

  return (
    <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900/40 dark:bg-amber-950/30">
      <button
        type="button"
        onClick={() => setCollapsed((previous) => !previous)}
        className="flex w-full items-center gap-2 text-left font-medium text-amber-900 dark:text-amber-200"
      >
        <KeyRound className="h-4 w-4 shrink-0" />
        <span className="flex-1">
          {outstanding.length === 1
            ? 'An imported credential group still needs a credential'
            : `${outstanding.length} imported credential groups still need credentials`}
        </span>
        {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
      </button>
      {!collapsed && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-amber-800 dark:text-amber-300">
            These steps shared credentials in the source system. Pick (or create) a workspace credential once per group
            — it applies to every step in the group.
          </p>
          {outstanding.map((group) => (
            <div key={group.key} className="flex items-center gap-3 rounded-md border border-amber-200/80 bg-card px-2 py-1.5 dark:border-amber-900/40">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{group.sourceDisplayName ?? group.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {group.nodeIds.length} step{group.nodeIds.length === 1 ? '' : 's'} · {group.sourceType}
                </p>
              </div>
              <div className="w-64 shrink-0">
                <CredentialPicker
                  type={group.credentialType!}
                  context="http"
                  draftSeed={groupDraftSeed(group)}
                  onChange={(credentialId, nextType) => {
                    if (credentialId) onBind(group, credentialId, nextType ?? group.credentialType ?? 'bearer')
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
