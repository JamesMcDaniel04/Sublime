'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataField } from '@/lib/flows/datatree'

function FieldRow({ field, depth, onInsert }: { field: DataField; depth: number; onInsert: (token: string) => void }) {
  const [open, setOpen] = useState(depth === 0)
  const hasChildren = Boolean(field.children && field.children.length)
  return (
    <div>
      <div className="flex items-center gap-1" style={{ paddingLeft: depth * 10 }}>
        {hasChildren ? (
          <button type="button" onClick={() => setOpen((v) => !v)} className="text-muted-foreground hover:text-foreground" aria-label={open ? 'Collapse' : 'Expand'}>
            <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="w-3" />
        )}
        <button
          type="button"
          onClick={() => onInsert(field.token)}
          title={`Insert ${field.token}`}
          className="flex flex-1 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs hover:bg-indigo-50 dark:hover:bg-indigo-500/10"
        >
          <span className="truncate font-mono text-[11px]">{field.label}</span>
          <span className="ml-auto shrink-0 text-[10px] uppercase text-muted-foreground">{field.type}</span>
        </button>
      </div>
      {open && hasChildren && field.children!.map((child) => <FieldRow key={child.token} field={child} depth={depth + 1} onInsert={onInsert} />)}
    </div>
  )
}

/** A datatree / datapill picker — click a field to insert its {{token}}. */
export function DataTree({ fields, onInsert }: { fields: DataField[]; onInsert: (token: string) => void }) {
  if (fields.length === 0) return <p className="px-1 py-0.5 text-[11px] text-muted-foreground">No upstream data yet.</p>
  return (
    <div className="max-h-52 overflow-y-auto rounded-lg border border-border bg-background p-1">
      {fields.map((field) => (
        <FieldRow key={field.token} field={field} depth={0} onInsert={onInsert} />
      ))}
    </div>
  )
}
