'use client'

import type { DataField } from '@/lib/flows/datatree'

/** Placeholder — Task 7 wires the datatree and drag insertion. */
export function InputPane({ dataFields }: { dataFields: DataField[]; onInsertToken: (token: string) => void }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <p className="border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Input</p>
      <p className="p-4 text-sm text-muted-foreground">{dataFields.length} field(s)</p>
    </div>
  )
}
