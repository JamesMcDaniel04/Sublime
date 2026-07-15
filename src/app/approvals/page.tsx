'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'

type Approval = {
  id: string
  tool: string
  summary: string
  status: string
  createdAt: string
  executionId: string
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deciding, setDeciding] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/approvals?status=pending', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not load approvals.')
      setApprovals(data.approvals ?? [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load approvals.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const decide = async (approval: Approval, decision: 'approve' | 'reject') => {
    if (decision === 'approve' && !window.confirm(`Approve ${approval.summary}? This may perform an external write.`)) return
    setDeciding(approval.id)
    try {
      const response = await fetch(`/api/approvals/${encodeURIComponent(approval.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || `Could not ${decision} this request.`)
      setApprovals((current) => current.filter((row) => row.id !== approval.id))
      toast.success(decision === 'approve' ? 'Approved. The run is resuming.' : 'Rejected. The run is resuming without the action.')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : `Could not ${decision} this request.`)
    } finally {
      setDeciding(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader eyebrow="Safety" title="Approvals" description="Review external writes before an agent or flow carries them out." />
        <Button variant="outline" size="icon" onClick={() => void load()} disabled={loading} aria-label="Refresh approvals" title="Refresh approvals">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>
      {error ? (
        <Card className="border-red-200"><CardContent className="flex items-center justify-between gap-4 p-4"><p className="text-sm text-red-700">{error}</p><Button variant="outline" onClick={() => void load()}>Try again</Button></CardContent></Card>
      ) : !loading && approvals.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No approvals waiting" description="New requests appear here when an agent or flow is about to perform an external write." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {approvals.map((approval) => (
            <Card key={approval.id}>
              <CardHeader className="pb-3"><CardTitle className="flex items-center justify-between gap-3 text-base"><span className="truncate">{approval.tool}</span><Badge variant="warn">Pending</Badge></CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div><p className="text-sm font-medium">{approval.summary}</p><p className="mt-1 text-xs text-muted-foreground">Requested {new Date(approval.createdAt).toLocaleString()} · run {approval.executionId}</p></div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" disabled={deciding !== null} loading={deciding === approval.id} onClick={() => void decide(approval, 'reject')}><X className="mr-1.5 h-4 w-4" />Reject</Button>
                  <Button disabled={deciding !== null} loading={deciding === approval.id} onClick={() => void decide(approval, 'approve')}><Check className="mr-1.5 h-4 w-4" />Approve</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
