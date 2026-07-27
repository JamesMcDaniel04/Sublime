'use client'

import { useState } from 'react'
import type { FlowNode } from '@/lib/flows/graph'
import { NODE_BODIES } from '../nodes/registry'
import type { NodeBodyProps } from '../nodes/types'
import { MissingFields } from '../nodes/missing-fields'
import { AdvancedParamsSection } from '../advanced-params'
import { HttpOptionsSection } from '../nodes/http-options'
import { StepSettingsFooter } from './step-settings-footer'

type HttpNode = Extract<FlowNode, { type: 'http' }>

/**
 * The middle pane. Parameters holds only what the step DOES; Settings holds
 * notes plus execution policy (retries, timeout, on-error, mock output) —
 * previously an accordion crammed into four different node bodies, and a
 * parallel "Options" panel on the HTTP node.
 */
export function ParamsPane(props: NodeBodyProps) {
  const { Body } = NODE_BODIES[props.node.type]
  const [tab, setTab] = useState<'parameters' | 'settings'>('parameters')
  const tabClass = (active: boolean) =>
    active
      ? 'border-b-2 border-rose-500 px-3 py-3 text-sm font-semibold text-foreground'
      : 'px-3 py-3 text-sm font-semibold text-muted-foreground'
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 flex border-b border-border bg-card px-4">
        <button type="button" onClick={() => setTab('parameters')} className={tabClass(tab === 'parameters')}>
          Parameters
        </button>
        <button type="button" onClick={() => setTab('settings')} className={tabClass(tab === 'settings')}>
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
        <div className="grid gap-4 p-4">
          {props.node.type !== 'trigger' && (
            <StepSettingsFooter node={props.node} update={props.update} tokenWiring={props.tokenWiring} />
          )}
          {props.node.type === 'http' ? (
            <HttpOptionsSection node={props.node as HttpNode} onChange={props.update} />
          ) : (
            <AdvancedParamsSection node={props.node} onChange={props.update} defaultOpen />
          )}
        </div>
      )}
    </div>
  )
}
