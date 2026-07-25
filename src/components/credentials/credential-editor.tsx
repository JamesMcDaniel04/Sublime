'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  FIELD_LABELS,
  SECRET_FIELDS,
  TYPE_LABELS,
  draftProblems,
  emptyDraft,
  fieldsForType,
  saveBody,
  type CredentialDraft,
  type CredentialField,
} from '@/lib/credentials/form'
import { CREDENTIAL_TYPES, type CredentialType, type CustomAuthEntry } from '@/lib/credentials/types'

const controlClass =
  'h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
const labelClass = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'

/**
 * Create/edit a vault credential.
 *
 * Secret inputs are write-only and always start blank — a redacted credential
 * carries no values to prefill, and a blank secret on save means "keep the
 * stored one" (see saveBody). So editing a header name never requires
 * re-typing the key.
 */
export function CredentialEditor({
  initial,
  credentialId,
  onSaved,
  onCancel,
}: Readonly<{
  initial?: CredentialDraft
  credentialId?: string
  onSaved: () => void
  onCancel: () => void
}>) {
  const editing = Boolean(credentialId)
  const [draft, setDraft] = useState<CredentialDraft>(initial ?? emptyDraft())
  const [saving, setSaving] = useState(false)
  const [showProblems, setShowProblems] = useState(false)
  const problems = draftProblems(draft, editing)
  const set = <K extends keyof CredentialDraft>(key: K, value: CredentialDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }))

  const save = async () => {
    if (problems.length > 0) {
      setShowProblems(true)
      return
    }
    setSaving(true)
    try {
      const response = await fetch(editing ? `/api/credentials/${credentialId}` : '/api/credentials', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(saveBody(draft, editing)),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not save the credential.')
      toast.success(editing ? 'Credential updated.' : 'Credential saved.')
      onSaved()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the credential.')
    } finally {
      setSaving(false)
    }
  }

  const entryRows = (which: 'headers' | 'query') => (
    <div className="grid gap-2">
      <label className={labelClass}>{which === 'headers' ? 'Headers' : 'Query parameters'}</label>
      {draft[which].map((entry, index) => (
        <div key={index} className="grid grid-cols-[1fr_1fr_36px] gap-2">
          <input
            value={entry.name}
            placeholder={which === 'headers' ? 'X-Api-Key' : 'api_key'}
            onChange={(event) =>
              set(which, draft[which].map((row, i) => (i === index ? { ...row, name: event.target.value } : row)) as CustomAuthEntry[])
            }
            className={controlClass}
            aria-label={`${which === 'headers' ? 'Header' : 'Query'} name ${index + 1}`}
          />
          <input
            type="password"
            value={entry.value}
            placeholder={editing ? 'Unchanged' : 'Value'}
            onChange={(event) =>
              set(which, draft[which].map((row, i) => (i === index ? { ...row, value: event.target.value } : row)) as CustomAuthEntry[])
            }
            className={controlClass}
            aria-label={`${which === 'headers' ? 'Header' : 'Query'} value ${index + 1}`}
          />
          <button
            type="button"
            onClick={() => set(which, draft[which].filter((_, i) => i !== index) as CustomAuthEntry[])}
            className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600"
            aria-label={`Remove ${which === 'headers' ? 'header' : 'query parameter'} ${index + 1}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => set(which, [...draft[which], { name: '', value: '' }] as CustomAuthEntry[])}
        className="flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:text-blue-900"
      >
        <Plus className="h-3.5 w-3.5" /> Add {which === 'headers' ? 'header' : 'query parameter'}
      </button>
    </div>
  )

  const fieldInput = (field: CredentialField) => {
    if (field === 'entries') {
      return (
        <div key="entries" className="grid gap-3">
          {entryRows('headers')}
          {entryRows('query')}
        </div>
      )
    }
    const isSecret = SECRET_FIELDS.has(field)
    return (
      <div key={field} className="grid gap-1.5">
        <label className={labelClass} htmlFor={`cred-${field}`}>
          {FIELD_LABELS[field]}
          {!isSecret || !editing ? <span className="ml-1 text-red-500">*</span> : null}
        </label>
        <input
          id={`cred-${field}`}
          type={isSecret ? 'password' : 'text'}
          autoComplete={isSecret ? 'new-password' : 'off'}
          value={String(draft[field] ?? '')}
          placeholder={isSecret && editing ? 'Unchanged — leave blank to keep it' : undefined}
          onChange={(event) => set(field, event.target.value as CredentialDraft[typeof field])}
          className={controlClass}
        />
      </div>
    )
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <label className={labelClass} htmlFor="cred-name">Name <span className="text-red-500">*</span></label>
        <input
          id="cred-name"
          value={draft.name}
          onChange={(event) => set('name', event.target.value)}
          placeholder="Acme production API"
          className={controlClass}
        />
      </div>

      <div className="grid gap-1.5">
        <label className={labelClass} htmlFor="cred-type">Type</label>
        <select
          id="cred-type"
          value={draft.type}
          onChange={(event) => set('type', event.target.value as CredentialType)}
          className={controlClass}
        >
          {CREDENTIAL_TYPES.map((type) => (
            <option key={type} value={type}>{TYPE_LABELS[type]}</option>
          ))}
        </select>
      </div>

      {fieldsForType(draft.type).map(fieldInput)}

      <div className="grid gap-1.5">
        <label className={labelClass} htmlFor="cred-domains">Allowed domains</label>
        <input
          id="cred-domains"
          value={draft.allowedDomains}
          onChange={(event) => set('allowedDomains', event.target.value)}
          placeholder="acme.com, api.other.io"
          className={controlClass}
        />
        <p className="text-[11px] leading-4 text-muted-foreground">
          {draft.allowedDomains.trim()
            ? 'This credential is only sent to these domains and their subdomains.'
            : 'Empty means this credential may be sent to any domain. Naming the domains you use limits the damage if a flow is mis-wired.'}
        </p>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium">Personal to me</span>
          <span className="block text-[11px] leading-4 text-muted-foreground">
            {draft.personal ? 'Only you can attach this to a step.' : 'Anyone in this workspace can attach this to a step.'}
          </span>
        </span>
        <Switch checked={draft.personal} onCheckedChange={(next) => set('personal', next)} aria-label="Personal to me" />
      </label>

      {showProblems && problems.length > 0 && (
        <ul className="list-disc rounded-lg bg-amber-50 py-2 pl-8 pr-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          {problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button size="sm" onClick={save} loading={saving} disabled={saving} className={cn(problems.length > 0 && showProblems && 'opacity-80')}>
          {editing ? 'Save changes' : 'Save credential'}
        </Button>
      </div>
    </div>
  )
}
