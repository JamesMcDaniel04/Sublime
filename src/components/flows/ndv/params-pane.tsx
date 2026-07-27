'use client'

import { useState } from 'react'
import { NODE_BODIES } from '../nodes/registry'
import type { NodeBodyProps } from '../nodes/types'
import { MissingFields } from '../nodes/missing-fields'
import { StepSettingsFooter } from './step-settings-footer'

/**
 * The middle pane: the very same body module the canvas card used to render
 * inline, plus the step-type/notes footer that used to close the expanded
 * card. One implementation, two consumers — the whole point of the registry.
 */
export function ParamsPane(props: NodeBodyProps) {
  const { Body } = NODE_BODIES[props.node.type]
  const [tab, setTab] = useState<'parameters' | 'settings'>('parameters')
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex border-b border-border bg-card px-4">
        <button
          type="button"
          onClick={() => setTab('parameters')}
          className={tab === 'parameters' ? 'border-b-2 border-rose-500 px-3 py-3 text-sm font-semibold text-foreground' : 'px-3 py-3 text-sm font-semibold text-muted-foreground'}
        >
          Parameters
        </button>
        <button
          type="button"
          onClick={() => setTab('settings')}
          className={tab === 'settings' ? 'border-b-2 border-rose-500 px-3 py-3 text-sm font-semibold text-foreground' : 'px-3 py-3 text-sm font-semibold text-muted-foreground'}
        >
          Settings
        </button>
      </div>
      {tab === 'parameters' ? (
        <>
          <MissingFields node={props.node} />
          <div className="p-4">
            <Body {...props} />
          </div>
        </>
      ) : (
        <div className="p-4">
          {props.node.type !== 'trigger' ? (
          <StepSettingsFooter node={props.node} update={props.update} tokenWiring={props.tokenWiring} />
          ) : (
            <p className="text-sm text-muted-foreground">This trigger has no additional step settings.</p>
          )}
        </div>
      )}
    </div>
  )
}
