'use client'

import { Plus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NODE_TYPES, type EditableType } from './node-types'

/** Shared "+ Add step" picker for the DAG canvas, stack canvas, and nested
 *  step bodies. Radix gives focus trap, Esc, typeahead, and collision-aware
 *  positioning that the previous hand-rolled backdrop menus lacked. */
export function AddStepMenu({ label = 'Add a step', onPick }: Readonly<{ label?: string; onPick: (type: EditableType) => void }>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-fast hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Plus className="h-4 w-4" /> {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] overflow-auto">
        {NODE_TYPES.map((type) => (
          <DropdownMenuItem key={type.value} className="text-xs" onSelect={() => onPick(type.value)}>
            {type.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
