'use client'

import type { DataField } from '@/lib/flows/datatree'
import { DataTree } from '../data-tree'

/**
 * The NDV's left pane: every upstream value this node can map from. Click
 * inserts at the caret of the last-focused param field; dragging a leaf drops
 * its braced token into any contenteditable token editor natively.
 */
export function InputPane({
  dataFields,
  onInsertToken,
}: {
  dataFields: DataField[]
  onInsertToken: (token: string) => void
}) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <p className="sticky top-0 z-10 border-b border-border bg-card px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Input
      </p>
      {dataFields.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No upstream data yet — run the flow once, or pin a step&apos;s output, and the fields you can map from will appear here.
        </p>
      ) : (
        <DataTree fields={dataFields} onInsert={onInsertToken} fill />
      )}
    </div>
  )
}
