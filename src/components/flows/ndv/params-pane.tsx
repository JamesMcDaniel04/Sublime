'use client'

import { NODE_BODIES } from '../nodes/registry'
import type { EditableType } from '../node-types'
import type { NodeBodyProps } from '../nodes/types'

/**
 * The middle pane: the very same body module the canvas card used to render
 * inline. One implementation, two consumers — the whole point of the registry.
 *
 * `onChangeType` is held for the settings footer that moves here when the
 * canvas card goes summary-only (Task 9) — unused until then.
 */
export function ParamsPane({ onChangeType: _onChangeType, ...props }: NodeBodyProps & { onChangeType?: (type: EditableType) => void }) {
  const { Body } = NODE_BODIES[props.node.type]
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <p className="sticky top-0 z-10 border-b border-border bg-card px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Parameters
      </p>
      <div className="p-4">
        <Body {...props} />
      </div>
    </div>
  )
}
