'use client'

import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import { TokenTextEditor } from '../token-text-editor'
import { labelClass, tokenControlBase } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function HumanReviewBody({
  node,
  update,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'humanReview' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const messageInvalid = Boolean(showErrors && !node.data.message.trim())
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Message <span className="text-red-500">*</span></label>
        <TokenTextEditor
          ref={registerEditor('hr.message')}
          multiline
          rows={4}
          value={node.data.message}
          labelCtx={labelCtx}
          onFocus={focusEditor('hr.message')}
          onChange={(message) => update({ ...node, data: { ...node.data, message } })}
          invalid={messageInvalid}
          className={cn(tokenControlBase, messageInvalid ? 'focus:border-red-500' : 'border-border')}
          placeholder="What should the person be asked? Their reply becomes this step's output."
          ariaLabel="Message"
        />
      </div>
      {/* No org-member roster is fetched anywhere in the builder today, so an
          assignee select would need a new members API + fetch. v1 keeps the
          engine default (data.assigneeUserId unset = the run owner is asked)
          and says so in plain english. */}
      <div className="grid gap-2">
        <label className={labelClass}>Assigned to</label>
        <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">The flow owner is asked by default. The run pauses here until they reply, and the reply becomes this step&apos;s output.</p>
      </div>
    </div>
  )
}

// MISSING_REVIEW_MESSAGE in validate.ts.
export const humanReviewModule: NodeBodyModule = {
  Body: ({ node, update, tokenWiring, showErrors }: NodeBodyProps) => (
    <HumanReviewBody node={node as Extract<FlowNode, { type: 'humanReview' }>} update={update} tokenWiring={tokenWiring} showErrors={showErrors} />
  ),
  defaultEditorKey: 'hr.message',
  requiredFields: ['message'],
}
