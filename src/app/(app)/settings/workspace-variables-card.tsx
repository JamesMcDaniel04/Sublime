'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

/**
 * Workspace variables: constants every flow can read as `{{workspace.<key>}}`.
 *
 * The API has existed since these landed; this is the screen. Without it the
 * only way to set one was an API call, which meant the feature effectively did
 * not exist for the people it was built for.
 *
 * Deliberately NOT a place for secrets, and the card says so. Values are
 * stored and displayed in the clear — a credential belongs in the vault, where
 * it is encrypted, revealed as a placeholder, and never enters a flow's
 * context.
 */

interface WorkspaceVariable {
  id: string
  key: string
  value: string
  description?: string | null
  updatedAt: string
}

export function WorkspaceVariablesCard({ isAdmin }: { isAdmin: boolean }) {
  const [variables, setVariables] = useState<WorkspaceVariable[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState({ key: '', value: '', description: '' })

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/workspace-variables')
      const body = await response.json()
      if (!response.ok || !body.success) throw new Error(body.error || 'Could not load workspace variables.')
      setVariables(body.variables ?? [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load workspace variables.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    const key = draft.key.trim()
    if (!key || !draft.value.trim()) {
      toast.error('A variable needs a name and a value.')
      return
    }
    setSaving(true)
    try {
      const response = await fetch('/api/workspace-variables', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value: draft.value, description: draft.description || undefined }),
      })
      const body = await response.json()
      if (!response.ok || !body.success) throw new Error(body.error || 'Could not save that variable.')
      setDraft({ key: '', value: '', description: '' })
      await load()
      toast.success(`Saved {{workspace.${key}}}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save that variable.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (key: string) => {
    // Flows referencing a deleted variable resolve to nothing rather than
    // failing, so the confirm says what actually happens.
    if (!window.confirm(`Delete {{workspace.${key}}}? Flows using it will read an empty value.`)) return
    try {
      const response = await fetch('/api/workspace-variables', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      const body = await response.json()
      if (!response.ok || !body.success) throw new Error(body.error || 'Could not delete that variable.')
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete that variable.')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace variables</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Constants every flow can read as <code className="text-xs">{'{{workspace.name}}'}</code> — a support address, a
          region, an environment label. Loaded once per run, so one flow reading the same variable in ten steps always
          sees one value.
        </p>
        <p className="text-xs text-muted-foreground">
          Not for secrets. These are stored and shown in the clear — put API keys and tokens in Credentials, where they
          are encrypted and never enter a flow&apos;s context.
        </p>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : variables.length === 0 ? (
          <p className="text-sm text-muted-foreground">No variables yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {variables.map((variable) => (
              <li key={variable.id} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0">
                  <code className="text-xs font-medium">{`{{workspace.${variable.key}}}`}</code>
                  <p className="truncate text-sm text-foreground">{variable.value}</p>
                  {variable.description && (
                    <p className="text-xs text-muted-foreground">{variable.description}</p>
                  )}
                </div>
                {isAdmin && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(variable.key)}
                    aria-label={`Delete ${variable.key}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {isAdmin && (
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input
              value={draft.key}
              onChange={(event) => setDraft((previous) => ({ ...previous, key: event.target.value }))}
              placeholder="support_email"
              aria-label="Variable name"
            />
            <Input
              value={draft.value}
              onChange={(event) => setDraft((previous) => ({ ...previous, value: event.target.value }))}
              placeholder="help@example.com"
              aria-label="Variable value"
            />
            <Button onClick={() => void save()} disabled={saving}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {saving ? 'Saving…' : 'Add'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
