'use client'

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  FIELD_LABELS,
  SECRET_FIELDS,
  SECRET_MASK,
  SECRET_PLACEHOLDER,
  TYPE_LABELS,
  activeFields,
  draftProblems,
  emptyDraft,
  saveBody,
  type CredentialDraft,
  type CredentialField,
} from '@/lib/credentials/form'
import { CREDENTIAL_TYPES, type CredentialType } from '@/lib/credentials/types'

export type SavedCredential = {
  id: string
  name: string
  type: string
  allowedDomains: string[]
}

type VerifyState = { state: 'verified'; status?: number } | { state: 'failed'; error: string }

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
  verifyAgainst,
  context = 'vault',
}: Readonly<{
  initial?: CredentialDraft
  credentialId?: string
  onSaved: (credential: SavedCredential) => void
  onCancel: () => void
  verifyAgainst?: string
  /**
   * Where the editor is mounted. 'http' hides fields an HTTP request can't
   * act on — today that is the private CA cert, which only the Postgres
   * source consumes. Offering it here would collect trust material that the
   * request path silently ignores.
   */
  /** 'vault' is the full Settings form; 'http'/'mcp' are the in-context ones. */
  context?: 'http' | 'vault' | 'mcp'
}>) {
  const editing = Boolean(credentialId)
  const [draft, setDraft] = useState<CredentialDraft>(initial ?? emptyDraft())
  const [saving, setSaving] = useState(false)
  const [showProblems, setShowProblems] = useState(false)
  // "Revealed" secret fields. Reveal never fetches anything — the server has
  // no decrypt path — it swaps the mask for a generic placeholder so the
  // invariant is visible instead of looking like a broken toggle.
  const [revealed, setRevealed] = useState<Partial<Record<CredentialField, boolean>>>({})
  // Survives the save so a failed check stays on screen instead of vanishing
  // with its toast — and so the credential is not attached behind the user's
  // back. `saved` holds the row awaiting an explicit "attach anyway".
  const [verification, setVerification] = useState<VerifyState | null>(null)
  const [saved, setSaved] = useState<SavedCredential | null>(null)
  const problems = draftProblems(draft, editing)
  const set = <K extends keyof CredentialDraft>(key: K, value: CredentialDraft[K]) => {
    // Any edit invalidates the previous check — it described different values.
    setVerification(null)
    setSaved(null)
    setDraft((previous) => ({ ...previous, [key]: value }))
  }

  const verify = async (credential: SavedCredential): Promise<VerifyState | null> => {
    if (!verifyAgainst || !/^https?:\/\//i.test(verifyAgainst)) return null
    try {
      const response = await fetch(`/api/credentials/${credential.id}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: verifyAgainst, method: 'GET' }),
      })
      const body = await response.json().catch(() => ({}))
      return response.ok
        ? { state: 'verified', status: body.status }
        : { state: 'failed', error: body.error || 'The endpoint rejected this credential.' }
    } catch (error) {
      return { state: 'failed', error: error instanceof Error ? error.message : 'Verification could not run.' }
    }
  }

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

      const result = await verify(body.credential)
      setVerification(result)
      // A credential that failed its check is saved but NOT attached: wiring it
      // into the step silently would hand the user a step that cannot work and
      // a green-looking editor that closed itself.
      if (result?.state === 'failed') {
        setSaved(body.credential)
        return
      }
      onSaved(body.credential)
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
              // Spreading `row` preserves originalName, which is what keeps a
              // renamed row attached to its stored secret.
              set(which, draft[which].map((row, i) => (i === index ? { ...row, name: event.target.value } : row)))
            }
            className={controlClass}
            aria-label={`${which === 'headers' ? 'Header' : 'Query'} name ${index + 1}`}
          />
          <input
            type="password"
            value={entry.value}
            placeholder={entry.originalName ? `${SECRET_MASK} — unchanged` : 'Value'}
            onChange={(event) =>
              set(which, draft[which].map((row, i) => (i === index ? { ...row, value: event.target.value } : row)))
            }
            className={controlClass}
            aria-label={`${which === 'headers' ? 'Header' : 'Query'} value ${index + 1}`}
          />
          <button
            type="button"
            onClick={() => set(which, draft[which].filter((_, i) => i !== index))}
            className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600"
            aria-label={`Remove ${which === 'headers' ? 'header' : 'query parameter'} ${index + 1}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        // A row added here has no originalName, so it is new and must carry a value.
        onClick={() => set(which, [...draft[which], { name: '', value: '' }])}
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
    if (field === 'signatureMethod' || field === 'grantType' || field === 'clientAuth') {
      const options =
        field === 'signatureMethod'
          ? [['HMAC-SHA256', 'HMAC-SHA256'], ['HMAC-SHA1', 'HMAC-SHA1']]
          : field === 'grantType'
            ? [['staticToken', 'Access token'], ['clientCredentials', 'Client credentials']]
            : [['header', 'HTTP Basic header'], ['body', 'Request body']]
      return (
        <div key={field} className="grid gap-1.5">
          <label className={labelClass} htmlFor={`cred-${field}`}>{FIELD_LABELS[field]}</label>
          <select
            id={`cred-${field}`}
            value={String(draft[field])}
            onChange={(event) => set(field, event.target.value as CredentialDraft[typeof field])}
            className={controlClass}
          >
            {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      )
    }
    const isSecret = SECRET_FIELDS.has(field)
    // A stored, untouched secret gets a masked hint and an eye toggle. The
    // toggle can only ever show SECRET_PLACEHOLDER: reads are redacted
    // server-side, so there is no value to reveal.
    const hasStored = editing && draft.storedSecrets.includes(field)
    const untouched = !String(draft[field] ?? '')
    const showPlaceholderReveal = isSecret && hasStored && untouched
    const isRevealed = showPlaceholderReveal && Boolean(revealed[field])
    return (
      <div key={field} className="grid gap-1.5">
        <label className={labelClass} htmlFor={`cred-${field}`}>
          {FIELD_LABELS[field]}
          {!isSecret || !editing ? <span className="ml-1 text-red-500">*</span> : null}
        </label>
        <div className="relative">
          <input
            id={`cred-${field}`}
            type={isSecret && !isRevealed ? 'password' : 'text'}
            autoComplete={isSecret ? 'new-password' : 'off'}
            readOnly={isRevealed}
            value={isRevealed ? SECRET_PLACEHOLDER : String(draft[field] ?? '')}
            placeholder={showPlaceholderReveal ? `${SECRET_MASK} — leave blank to keep it` : undefined}
            onChange={(event) => {
              if (isRevealed) return
              set(field, event.target.value as CredentialDraft[typeof field])
            }}
            className={cn(controlClass, showPlaceholderReveal && 'pr-10', isRevealed && 'text-muted-foreground')}
          />
          {showPlaceholderReveal && (
            <button
              type="button"
              onClick={() => setRevealed((previous) => ({ ...previous, [field]: !previous[field] }))}
              className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
              aria-label={isRevealed ? `Hide ${FIELD_LABELS[field]}` : `Reveal ${FIELD_LABELS[field]}`}
            >
              {isRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          )}
        </div>
        {isRevealed && (
          <p className="text-[11px] leading-4 text-muted-foreground">
            Stored secrets can never be displayed — this is a placeholder. Type a new value to replace the stored one.
          </p>
        )}
      </div>
    )
  }

  // activeFields is the same helper validation and serialization use, so the
  // form can't show a field the save body would drop (or vice versa).
  const visibleFields = activeFields(draft)

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

      {visibleFields.map(fieldInput)}

      {context === 'vault' && (draft.type === 'bearer' || draft.type === 'apiKeyHeader') && (
        <div className="grid gap-1.5">
          <label className={labelClass} htmlFor="cred-ca-cert">
            Private CA certificate (optional)
          </label>
          <textarea
            id="cred-ca-cert"
            value={draft.caCert}
            onChange={(event) => set('caCert', event.target.value)}
            placeholder={editing ? 'Unchanged — leave blank to keep it' : '-----BEGIN CERTIFICATE-----'}
            className={`${controlClass} min-h-28 py-2 font-mono`}
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            Trust material for database connections signed by a private CA. TLS verification stays enabled.
          </p>
        </div>
      )}

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
            : 'Required. Credentials are never sent until at least one destination domain is allowed.'}
        </p>
      </div>

      <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        This credential is shared with your workspace: any member can attach it to steps that call an allowed domain.
        Secret values are write-only — they can be replaced, but never viewed or exported.
      </p>

      {showProblems && problems.length > 0 && (
        <ul className="list-disc rounded-lg bg-amber-50 py-2 pl-8 pr-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          {problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      )}

      {verification?.state === 'verified' && (
        <p className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Verified against {verifyAgainst}{verification.status ? ` — HTTP ${verification.status}` : ''}.
        </p>
      )}

      {verification?.state === 'failed' && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" /> Saved, but the endpoint rejected it
          </p>
          <p className="mt-1.5 break-words font-mono text-[11px] leading-relaxed">{verification.error}</p>
          <p className="mt-2">
            The credential is stored. Fix it here, or attach it anyway if the check itself is wrong — some endpoints
            refuse a bare GET even with valid credentials.
          </p>
          {saved && (
            <Button size="sm" variant="outline" className="mt-2" onClick={() => onSaved(saved)}>
              Attach anyway
            </Button>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button size="sm" onClick={save} loading={saving} disabled={saving} className={cn(problems.length > 0 && showProblems && 'opacity-80')}>
          {saved ? 'Save & re-check' : editing ? 'Save changes' : verifyAgainst ? 'Save & verify' : 'Save credential'}
        </Button>
      </div>
    </div>
  )
}
