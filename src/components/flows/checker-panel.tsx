'use client'

import { AlertTriangle, ChevronRight, CheckCircle2, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { FlowValidationIssue, FlowValidationResult } from '@/lib/flows/validate'
import type { FlowFailureRemediation } from '@/lib/flows/failure-remediation'

function IssueRow({ issue, onJump }: { issue: FlowValidationIssue; onJump: (nodeId: string) => void }) {
  const dot = issue.level === 'error' ? 'bg-red-500' : 'bg-amber-500'
  const content = (
    <>
      <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
      <span className="min-w-0 flex-1 text-sm">{issue.message}</span>
      {issue.nodeId && <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
    </>
  )
  if (!issue.nodeId) {
    return <div className="flex items-start gap-2 px-3 py-2">{content}</div>
  }
  return (
    <button
      type="button"
      onClick={() => onJump(issue.nodeId!)}
      className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/50"
    >
      {content}
    </button>
  )
}

export function CheckerPanel({
  validation,
  onJump,
  onFixWithCopilot,
  runtimeFailure,
  onRemediateFailure,
  fixing,
  onClose,
}: {
  validation: FlowValidationResult
  onJump: (nodeId: string) => void
  onFixWithCopilot: () => void
  runtimeFailure?: FlowFailureRemediation | null
  onRemediateFailure?: (remediation: FlowFailureRemediation) => void
  fixing: boolean
  onClose: () => void
}) {
  const hasValidationIssues = validation.errors.length > 0 || validation.warnings.length > 0
  const hasIssues = hasValidationIssues || Boolean(runtimeFailure)
  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Flow checker</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="border-b border-border px-4 py-2">
        {hasIssues ? (
          <p className="text-xs text-muted-foreground">
            {runtimeFailure ? 'Latest run failed' : `${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'} · ${validation.warnings.length} warning${validation.warnings.length === 1 ? '' : 's'}`}
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
            <CheckCircle2 className="h-3.5 w-3.5" /> All checks pass
          </p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {!hasIssues ? (
          <p className="p-4 text-sm text-muted-foreground">No problems found — this flow is ready to run.</p>
        ) : (
          <>
            {runtimeFailure && (
              <div className="border-b border-border/60 p-3">
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/40 dark:bg-red-950/30">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-red-900 dark:text-red-200">{runtimeFailure.title}</p>
                      <p className="mt-1 text-xs leading-relaxed text-red-800 dark:text-red-300">{runtimeFailure.summary}</p>
                      <p className="mt-2 break-words rounded bg-background/70 px-2 py-1.5 font-mono text-[11px] text-red-700 dark:text-red-300">{runtimeFailure.error}</p>
                    </div>
                  </div>
                  {runtimeFailure.userSteps.length > 0 && (
                    <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-foreground">
                      {runtimeFailure.userSteps.map((step) => <li key={step}>{step}</li>)}
                    </ol>
                  )}
                  {runtimeFailure.nodeId && (
                    <button type="button" onClick={() => onJump(runtimeFailure.nodeId!)} className="mt-2 text-xs font-semibold text-indigo-700 hover:underline">
                      Open failing step
                    </button>
                  )}
                </div>
              </div>
            )}
            {validation.errors.length > 0 && (
              <div>
                <p className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-red-600">Errors</p>
                {validation.errors.map((issue, i) => (
                  <IssueRow key={`error-${issue.code}-${issue.nodeId ?? 'flow'}-${i}`} issue={issue} onJump={onJump} />
                ))}
              </div>
            )}
            {validation.warnings.length > 0 && (
              <div>
                <p className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-600">Warnings</p>
                {validation.warnings.map((issue, i) => (
                  <IssueRow key={`warning-${issue.code}-${issue.nodeId ?? 'flow'}-${i}`} issue={issue} onJump={onJump} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {hasIssues && (
        <div className="border-t border-border p-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => runtimeFailure && onRemediateFailure ? onRemediateFailure(runtimeFailure) : onFixWithCopilot()}
            loading={fixing}
            disabled={fixing}
          >
            <Sparkles className="mr-1.5 h-4 w-4" /> {runtimeFailure?.actionLabel || 'Fix with Copilot'}
          </Button>
        </div>
      )}
    </div>
  )
}
