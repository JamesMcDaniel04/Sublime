'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, KeyRound, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TYPE_LABELS, draftFromRedacted, emptyDraft, type CredentialDraft } from '@/lib/credentials/form'
import { CREDENTIAL_TYPES, type CredentialType, type RedactedCredential } from '@/lib/credentials/types'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SearchableSelect } from '@/components/flows/searchable-select'
import { CredentialHealth } from '@/components/flows/nodes/credential-health'
import { controlClass, labelClass } from '@/components/flows/nodes/field-primitives'
import type { VerificationView } from '@/components/flows/nodes/verification-badge'
import { CredentialEditor } from './credential-editor'

type ListedCredential = {
  id: string
  name: string
  type: string
  allowedDomains: string[]
  personal?: boolean
  config?: RedactedCredential
  verification?: VerificationView
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname
  } catch {
    return ''
  }
}

function domainMatches(hostname: string, allowedDomains: string[]) {
  if (!hostname) return true
  if (allowedDomains.length === 0) return false
  const host = hostname.toLowerCase()
  return allowedDomains.some((raw) => {
    const domain = raw.trim().toLowerCase().replace(/^\.+/, '')
    return Boolean(domain && (host === domain || host.endsWith(`.${domain}`)))
  })
}

/**
 * Choose, create, verify, or repair a stored credential — one surface for all
 * of it, so every consumer gets domain filtering, health, and in-place editing
 * rather than a detour to Settings.
 *
 * Extracted from the HTTP node body unchanged; http-curl-auth.test.tsx is the
 * contract that the extraction changed no behavior.
 */
export function CredentialPicker({
  value,
  type,
  onChange,
  verifyAgainst,
  context,
  draftSeed,
}: {
  value?: string
  type: CredentialType
  onChange: (credentialId: string | undefined, type: CredentialType) => void
  /** URL the verify probe hits, and the domain the list is filtered by. */
  verifyAgainst?: string
  context: 'http' | 'mcp'
  /** Prefill for the CREATE form only (import knows the integration's real
   *  header/query names) — never applied when editing a stored credential. */
  draftSeed?: Partial<CredentialDraft>
}) {
  const [credentials, setCredentials] = useState<ListedCredential[]>([])
  // null = closed. `{ id }` edits that stored credential; `{}` creates one.
  const [credentialModal, setCredentialModal] = useState<{ id?: string; draft: CredentialDraft } | null>(null)

  const loadCredentials = useCallback(async () => {
    const response = await fetch('/api/credentials')
    const body = await response.json().catch(() => ({}))
    if (response.ok) setCredentials(body.credentials ?? [])
  }, [])

  useEffect(() => {
    void loadCredentials().catch(() => undefined)
  }, [loadCredentials])

  const hostname = hostnameOf(verifyAgainst ?? '')
  const selectedCredential = credentials.find((credential) => credential.id === value)
  const compatibleCredentials = useMemo(
    () => credentials.filter((credential) => credential.type === type && domainMatches(hostname, credential.allowedDomains)),
    [credentials, type, hostname],
  )

  const startCredentialDraft = {
    ...emptyDraft(),
    name: hostname ? `${hostname} ${TYPE_LABELS[type]}` : `Unnamed ${TYPE_LABELS[type]}`,
    type,
    allowedDomains: hostname,
    ...draftSeed,
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <label className={labelClass}>Generic Auth Type</label>
        <div className="relative">
          <select
            aria-label="Generic auth type"
            value={type}
            onChange={(event) => onChange(undefined, event.target.value as CredentialType)}
            className={cn(controlClass, 'w-full appearance-none pr-9')}
          >
            {CREDENTIAL_TYPES.map((entry) => <option key={entry} value={entry}>{TYPE_LABELS[entry]}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <SearchableSelect
          value={value ?? ''}
          ariaLabel={`${TYPE_LABELS[type]} credential`}
          placeholder={`Choose ${TYPE_LABELS[type]}`}
          emptyLabel={hostname ? `No ${TYPE_LABELS[type]} credentials match ${hostname}.` : `No ${TYPE_LABELS[type]} credentials yet.`}
          options={compatibleCredentials.map((credential) => ({
            value: credential.id,
            label: credential.name,
            hint: credential.allowedDomains.length ? credential.allowedDomains.join(', ') : 'blocked until a domain is added',
          }))}
          onChange={(credentialId) => onChange(credentialId || undefined, type)}
        />
        <div className="flex gap-2">
          {/* Without this there was no route from a step to a wrong
              credential — the only fix was to leave and find it in
              Settings, or create a duplicate. */}
          {selectedCredential?.config && (
            <button
              type="button"
              aria-label={`Edit ${selectedCredential.name}`}
              onClick={() => setCredentialModal({
                id: selectedCredential.id,
                draft: draftFromRedacted({
                  name: selectedCredential.name,
                  type: selectedCredential.type,
                  personal: selectedCredential.personal ?? true,
                  allowedDomains: selectedCredential.allowedDomains,
                  config: selectedCredential.config as RedactedCredential,
                }),
              })}
              className="flex h-10 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-semibold text-foreground hover:bg-muted"
            >
              <Pencil className="h-4 w-4" /> Edit
            </button>
          )}
          <button
            type="button"
            onClick={() => setCredentialModal({ draft: startCredentialDraft })}
            className="flex h-10 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-semibold text-foreground hover:bg-muted"
          >
            <KeyRound className="h-4 w-4" /> Set up credential
          </button>
        </div>
      </div>
      <CredentialHealth
        credentialId={value}
        verification={selectedCredential?.verification}
        requestUrl={verifyAgainst}
        onRechecked={() => void loadCredentials().catch(() => undefined)}
      />
      <p className="text-xs text-muted-foreground">
        Credentials are encrypted, scoped to your account by default, and reusable by other steps that call an allowed domain.
      </p>

      <Dialog open={credentialModal !== null} onOpenChange={(open) => !open && setCredentialModal(null)}>
        <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{credentialModal?.id ? `Edit ${credentialModal.draft.name}` : TYPE_LABELS[type]}</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Save once, verify with a safe GET to this endpoint, then reuse it wherever an allowed domain is called.
            </p>
          </DialogHeader>
          {credentialModal && (
            <CredentialEditor
              key={credentialModal.id ?? 'new'}
              credentialId={credentialModal.id}
              initial={credentialModal.draft}
              context={context}
              verifyAgainst={verifyAgainst}
              onSaved={(credential) => {
                onChange(credential.id, credential.type as CredentialType)
                setCredentialModal(null)
                // Refetch rather than splice in the returned row: only the list
                // endpoint carries the redacted config and verification state
                // the picker and health badge render.
                void loadCredentials().catch(() => undefined)
              }}
              onCancel={() => setCredentialModal(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
