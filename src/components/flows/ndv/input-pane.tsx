'use client'

import { useState } from 'react'
import type { DataField } from '@/lib/flows/datatree'
import { DataTree } from '../data-tree'

/**
 * The NDV's left pane: every upstream value this node can map from. Click
 * inserts at the caret of the last-focused param field; dragging a leaf drops
 * its braced token into any contenteditable token editor natively.
 */
export function InputPane({
  dataFields,
  rawInput,
  onInsertToken,
}: {
  dataFields: DataField[]
  rawInput?: unknown
  onInsertToken: (token: string) => void
}) {
  const [view, setView] = useState<'raw' | 'fields'>(rawInput !== undefined ? 'raw' : 'fields')
  const hasRaw = rawInput !== undefined
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Input</p>
        {hasRaw && dataFields.length > 0 && (
          <div className="flex rounded-md bg-muted p-0.5 text-[10px] font-semibold">
            <button type="button" onClick={() => setView('raw')} className={view === 'raw' ? 'rounded bg-background px-2 py-1 shadow-sm' : 'px-2 py-1 text-muted-foreground'}>Raw</button>
            <button type="button" onClick={() => setView('fields')} className={view === 'fields' ? 'rounded bg-background px-2 py-1 shadow-sm' : 'px-2 py-1 text-muted-foreground'}>Fields</button>
          </div>
        )}
      </div>
      {view === 'raw' && hasRaw ? (
        <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
          {typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput, null, 2)}
        </pre>
      ) : dataFields.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No upstream data yet — run the flow once, or pin a step&apos;s output, and the fields you can map from will appear here.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DataTree fields={dataFields} onInsert={onInsertToken} fill />
        </div>
      )}
    </div>
  )
}
