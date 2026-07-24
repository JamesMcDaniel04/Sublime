'use client'

import { AlertCircle } from 'lucide-react'
import type { FlowNode } from '@/lib/flows/graph'
import { NODE_BODIES } from './registry'

/**
 * Which of this node type's required `data` keys are still unset.
 *
 * "Present but useless" counts as missing — an empty string, a whitespace-only
 * string, and an empty array all mean the step can't run, and a plain
 * null-check would pass all three.
 */
export function missingRequiredFields(node: FlowNode): string[] {
  const required = NODE_BODIES[node.type]?.requiredFields ?? []
  const data = node.data as Record<string, unknown>
  return required.filter((field) => {
    const value = data[field]
    if (value === undefined || value === null) return true
    if (typeof value === 'string') return value.trim() === ''
    if (Array.isArray(value)) return value.length === 0
    return false
  })
}

/**
 * Advisory summary above the params. Never blocks editing — a half-finished
 * step is a normal state while authoring, and Phase 2's per-node test already
 * scopes hard failures to the node being tested.
 */
export function MissingFields({ node }: Readonly<{ node: FlowNode }>) {
  const missing = missingRequiredFields(node)
  if (missing.length === 0) return null
  return (
    <p className="flex items-start gap-1.5 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] leading-4 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>
        Still needed before this step can run: <span className="font-mono">{missing.join(', ')}</span>
      </span>
    </p>
  )
}
