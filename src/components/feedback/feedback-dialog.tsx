'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const CATEGORIES = [
  { value: 'COMPLAINT', label: 'Something went wrong' },
  { value: 'IDEA', label: 'Idea or request' },
  { value: 'QUESTION', label: 'Question' },
  { value: 'OTHER', label: 'Other' },
] as const

export function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const pathname = usePathname()
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['value']>('COMPLAINT')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    if (open) { setSent(false); setError(null) }
  }, [open])

  async function submit() {
    if (!message.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, message: message.trim(), path: pathname || undefined }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'Could not send feedback — please try again.')
      setMessage('')
      setSent(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send feedback — please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>Tell us what happened or what would make Sublime better. We read every message.</DialogDescription>
        </DialogHeader>
        {sent ? (
          <div className="space-y-4">
            <p className="rounded-lg bg-muted p-4 text-sm">Thanks — we read every message.</p>
            <DialogFooter><Button onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <label className="grid gap-2 text-sm font-medium">Category
              <select value={category} onChange={(event) => setCategory(event.target.value as typeof category)} className="h-10 rounded-md border border-border bg-background px-3 text-sm">
                {CATEGORIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label className="grid gap-2 text-sm font-medium">Message
              <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={7} maxLength={5000} className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" placeholder="What should we know?" />
            </label>
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" loading={busy} disabled={!message.trim()}>Send feedback</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
