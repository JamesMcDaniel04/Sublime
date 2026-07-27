'use client'

import { AddStepMenu } from '../add-step-menu'
import { ContainerSteps } from './container-children'
import type { NodeBodyModule, NodeBodyProps } from './types'

function ErrorShieldBody(props: NodeBodyProps) {
  const { onAddStep } = props
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Runs the body below. If a body step fails, the fallback runs instead — with the error available as{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">{'{{error}}'}</code> — and this step still succeeds.
      </p>
      <ContainerSteps {...props} />
      {onAddStep && <AddStepMenu label="Add step to body" onPick={onAddStep} />}
      {onAddStep && <AddStepMenu label="Add fallback step" onPick={(type) => onAddStep(type, -1)} />}
    </div>
  )
}

// EMPTY_SHIELD_BODY in validate.ts requires at least one body step.
export const errorShieldModule: NodeBodyModule = {
  Body: ErrorShieldBody,
  requiredFields: ['body'],
}
