'use client'

import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AgentConfigForm, type AgentDraft } from './agent-config-form'

/**
 * Dialog wrapper around the shared AgentConfigForm. The dashboard renders the
 * form inline as the setup pane; this wrapper keeps the modal entry point for
 * any surface that still opens agent config in an overlay.
 */
export function AgentConfigDialog({
  open,
  onOpenChange,
  onCreateAgent,
  onRunAgent,
  editingAgent,
  template,
  runningId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateAgent: (draft: AgentDraft) => Promise<void> | void
  onRunAgent?: (agent: any) => Promise<void> | void
  editingAgent?: any
  template?: any
  runningId?: string | null
}) {
  const router = useRouter()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingAgent ? 'Edit agent' : 'New agent'}</DialogTitle>
        </DialogHeader>
        <AgentConfigForm
          active={open}
          editingAgent={editingAgent}
          template={template}
          onRunAgent={onRunAgent}
          runningId={runningId}
          onOpenRun={(runId) => {
            onOpenChange(false)
            router.push(`/dashboard?run=${runId}`)
          }}
          onSave={async (draft) => {
            await onCreateAgent(draft)
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
