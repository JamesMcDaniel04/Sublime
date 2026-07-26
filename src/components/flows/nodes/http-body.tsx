'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, KeyRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import { parseCurlCommand } from '@/lib/flows/curl-import'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { TYPE_LABELS, emptyDraft } from '@/lib/credentials/form'
import { CREDENTIAL_TYPES, type CredentialType } from '@/lib/credentials/types'
import { CredentialEditor } from '@/components/credentials/credential-editor'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { TokenTextEditor } from '../token-text-editor'
import { SearchableSelect } from '../searchable-select'
import { AdvancedParamsSection } from '../advanced-params'
import type { ToolCatalog } from '../tool-catalog-type'
import { InlineKeyValue } from './inline-key-value'
import { controlClass, labelClass, tokenControlBase, tokenControlClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'
import { FieldPreview } from './field-preview'

type HttpNode = Extract<FlowNode, { type: 'http' }>
type ListedCredential = {
  id: string
  name: string
  type: string
  allowedDomains: string[]
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname
  } catch {
    return ''
  }
}

function domainMatches(hostname: string, allowedDomains: string[]) {
  if (!hostname || allowedDomains.length === 0) return true
  const host = hostname.toLowerCase()
  return allowedDomains.some((raw) => {
    const domain = raw.trim().toLowerCase().replace(/^\.+/, '')
    return Boolean(domain && (host === domain || host.endsWith(`.${domain}`)))
  })
}

function ToggleSection({
  label,
  checked,
  onCheckedChange,
  disabled,
  children,
}: {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm font-medium text-foreground">{label}</label>
        <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-label={label} />
      </div>
      {checked && !disabled ? children : null}
    </section>
  )
}

function StructuredInput({
  label,
  editorKey,
  value,
  mode,
  onModeChange,
  onChange,
  tokenWiring,
  rows = 5,
}: {
  label: string
  editorKey: string
  value?: string
  mode: 'json' | 'fields'
  onModeChange: (mode: 'json' | 'fields') => void
  onChange: (value: string) => void
  tokenWiring: TokenEditorWiring
  rows?: number
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  return (
    <div className="grid gap-2">
      <label className={labelClass}>Specify {label}</label>
      <select
        aria-label={`Specify ${label}`}
        value={mode}
        onChange={(event) => onModeChange(event.target.value as 'json' | 'fields')}
        className={controlClass}
      >
        <option value="json">Using JSON</option>
        <option value="fields">Using fields below</option>
      </select>
      {mode === 'fields' ? (
        <InlineKeyValue
          label={label}
          editorKey={editorKey}
          value={value}
          onChange={onChange}
          tokenWiring={tokenWiring}
        />
      ) : (
        <TokenTextEditor
          ref={registerEditor(editorKey)}
          multiline
          rows={rows}
          value={value ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor(editorKey)}
          onChange={onChange}
          className={cn(tokenControlClass, 'font-mono text-xs')}
          placeholder={'{\n  "name": "value"\n}'}
          ariaLabel={`${label} JSON`}
        />
      )}
    </div>
  )
}

function HttpBody({
  node,
  toolCatalog,
  update,
  tokenWiring,
  showErrors,
  previewContext,
}: {
  node: HttpNode
  toolCatalog: ToolCatalog
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
  previewContext?: NodeBodyProps['previewContext']
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const authMode: 'none' | 'predefined' | 'generic' =
    node.data.authMode ?? (node.data.credentialId ? 'generic' : node.data.connectionId ? 'predefined' : 'none')
  const [credentials, setCredentials] = useState<ListedCredential[]>([])
  const [credentialOpen, setCredentialOpen] = useState(false)
  const [curlOpen, setCurlOpen] = useState(false)
  const [curlText, setCurlText] = useState('')
  const [curlError, setCurlError] = useState<string | null>(null)

  const loadCredentials = useCallback(async () => {
    const response = await fetch('/api/credentials')
    const body = await response.json().catch(() => ({}))
    if (response.ok) setCredentials(body.credentials ?? [])
  }, [])

  useEffect(() => {
    if (authMode === 'generic') void loadCredentials().catch(() => undefined)
  }, [authMode, loadCredentials])

  const patch = (data: Partial<HttpNode['data']>) => update({ ...node, data: { ...node.data, ...data } })
  const urlInvalid = Boolean(showErrors && !node.data.url)
  const authConnections = toolCatalog.filter((entry) => parseFlowToolConnectionId(entry.id).plane === 'mcp')
  const hostname = hostnameOf(node.data.url)
  const selectedCredential = credentials.find((credential) => credential.id === node.data.credentialId)
  const credentialType = (node.data.credentialType ?? selectedCredential?.type ?? 'basic') as CredentialType
  const compatibleCredentials = useMemo(
    () => credentials.filter((credential) => credential.type === credentialType && domainMatches(hostname, credential.allowedDomains)),
    [credentials, credentialType, hostname],
  )
  const bodyAllowed = BODY_METHODS.has(node.data.method)
  const sendQuery = node.data.sendQuery ?? Boolean(node.data.query?.trim())
  const sendHeaders = node.data.sendHeaders ?? Boolean(node.data.headers?.trim())
  const sendBody = bodyAllowed && (node.data.sendBody ?? Boolean(node.data.body?.trim()))
  const queryMode = node.data.queryMode ?? 'json'
  const headersMode = node.data.headersMode ?? 'json'
  const bodyInputMode = node.data.bodyInputMode ?? 'json'
  const bodyMode = node.data.bodyMode === 'text' ? 'raw' : node.data.bodyMode ?? 'json'

  const importCurl = () => {
    try {
      const imported = parseCurlCommand(curlText)
      patch({
        ...imported,
        sendHeaders: Boolean(imported.headers),
        sendBody: Boolean(imported.body),
      })
      setCurlOpen(false)
      setCurlText('')
      setCurlError(null)
    } catch (error) {
      setCurlError(error instanceof Error ? error.message : String(error))
    }
  }

  const startCredentialDraft = {
    ...emptyDraft(),
    name: hostname ? `${hostname} ${TYPE_LABELS[credentialType]}` : `Unnamed ${TYPE_LABELS[credentialType]}`,
    type: credentialType,
    allowedDomains: hostname,
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 pb-16">
      <div className="flex justify-end">
        <button
          type="button"
          aria-label="Import cURL"
          onClick={() => { setCurlOpen((value) => !value); setCurlError(null) }}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground shadow-sm hover:bg-muted"
        >
          Import cURL
        </button>
      </div>

      {curlOpen && (
        <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3">
          <label className={labelClass}>Paste a cURL command</label>
          <textarea
            aria-label="cURL command"
            rows={4}
            value={curlText}
            onChange={(event) => setCurlText(event.target.value)}
            className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground outline-none focus:border-blue-500"
            placeholder="curl -X POST https://api.example.com -H 'Content-Type: application/json' --data '{...}'"
          />
          {curlError && <p className="text-xs text-red-500">{curlError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCurlOpen(false)} className="rounded-md px-2.5 py-1.5 text-xs font-semibold text-muted-foreground">Cancel</button>
            <button type="button" aria-label="Apply cURL import" onClick={importCurl} className="rounded-md bg-foreground px-2.5 py-1.5 text-xs font-semibold text-background">Import</button>
          </div>
        </div>
      )}

      <div className="grid gap-2">
        <label className={labelClass}>Method</label>
        <select
          aria-label="Method"
          value={node.data.method}
          onChange={(event) => patch({ method: event.target.value as HttpNode['data']['method'] })}
          className={controlClass}
        >
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => <option key={method}>{method}</option>)}
        </select>
      </div>

      <div className="grid gap-2">
        <label className={labelClass}>URL <span className="text-red-500">*</span></label>
        <TokenTextEditor
          ref={registerEditor('http.url')}
          value={node.data.url}
          labelCtx={labelCtx}
          onFocus={focusEditor('http.url')}
          onChange={(url) => patch({ url })}
          invalid={urlInvalid}
          className={cn(tokenControlBase, urlInvalid ? 'focus:border-red-500' : 'border-border')}
          placeholder="https://api.example.com/endpoint"
          ariaLabel="URI"
        />
        <FieldPreview value={node.data.url} ctx={previewContext} />
      </div>

      <div className="grid gap-2">
        <label className={labelClass}>Authentication</label>
        <select
          aria-label="Authentication"
          value={authMode}
          onChange={(event) => {
            const mode = event.target.value as 'none' | 'predefined' | 'generic'
            patch({
              authMode: mode,
              ...(mode === 'predefined' ? { credentialId: undefined, credentialType: undefined } : {}),
              ...(mode === 'generic' ? { connectionId: undefined } : {}),
              ...(mode === 'none' ? { connectionId: undefined, credentialId: undefined, credentialType: undefined } : {}),
            })
          }}
          className={controlClass}
        >
          <option value="none">None</option>
          <option value="predefined">Predefined Credential Type</option>
          <option value="generic">Generic Credential Type</option>
        </select>

        {authMode === 'predefined' && (
          <>
            <select
              aria-label="Predefined credential"
              value={node.data.connectionId ?? ''}
              onChange={(event) => patch({ connectionId: event.target.value || undefined })}
              className={controlClass}
            >
              <option value="">Choose an authorized integration</option>
              {authConnections.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">Reuse an integration you have already authorized.</p>
          </>
        )}

        {authMode === 'generic' && (
          <div className="grid gap-3">
            <div className="grid gap-2">
              <label className={labelClass}>Generic Auth Type</label>
              <div className="relative">
                <select
                  aria-label="Generic auth type"
                  value={credentialType}
                  onChange={(event) => patch({
                    credentialType: event.target.value as CredentialType,
                    credentialId: undefined,
                  })}
                  className={cn(controlClass, 'w-full appearance-none pr-9')}
                >
                  {CREDENTIAL_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <SearchableSelect
                value={node.data.credentialId ?? ''}
                ariaLabel={`${TYPE_LABELS[credentialType]} credential`}
                placeholder={`Choose ${TYPE_LABELS[credentialType]}`}
                emptyLabel={hostname ? `No ${TYPE_LABELS[credentialType]} credentials match ${hostname}.` : `No ${TYPE_LABELS[credentialType]} credentials yet.`}
                options={compatibleCredentials.map((credential) => ({
                  value: credential.id,
                  label: credential.name,
                  hint: credential.allowedDomains.length ? credential.allowedDomains.join(', ') : 'any domain',
                }))}
                onChange={(credentialId) => patch({ credentialId: credentialId || undefined })}
              />
              <button
                type="button"
                onClick={() => setCredentialOpen(true)}
                className="flex h-10 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-semibold text-foreground hover:bg-muted"
              >
                <KeyRound className="h-4 w-4" /> Set up credential
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Credentials are encrypted, scoped to your account by default, and reusable by other HTTP nodes that call an allowed domain.
            </p>
          </div>
        )}
      </div>

      <ToggleSection label="Send Query Parameters" checked={sendQuery} onCheckedChange={(checked) => patch({ sendQuery: checked })}>
        <StructuredInput
          label="Query Parameters"
          editorKey="http.query"
          value={node.data.query}
          mode={queryMode}
          onModeChange={(mode) => patch({ queryMode: mode })}
          onChange={(query) => patch({ query })}
          tokenWiring={tokenWiring}
        />
      </ToggleSection>

      <ToggleSection label="Send Headers" checked={sendHeaders} onCheckedChange={(checked) => patch({ sendHeaders: checked })}>
        <StructuredInput
          label="Headers"
          editorKey="http.headers"
          value={node.data.headers}
          mode={headersMode}
          onModeChange={(mode) => patch({ headersMode: mode })}
          onChange={(headers) => patch({ headers })}
          tokenWiring={tokenWiring}
        />
      </ToggleSection>

      <ToggleSection
        label="Send Body"
        checked={sendBody}
        onCheckedChange={(checked) => patch({ sendBody: checked })}
        disabled={!bodyAllowed}
      >
        <div className="grid gap-3">
          <div className="grid gap-2">
            <label className={labelClass}>Body Content Type</label>
            <select
              aria-label="Body Content Type"
              value={bodyMode}
              onChange={(event) => patch({ bodyMode: event.target.value as HttpNode['data']['bodyMode'] })}
              className={controlClass}
            >
              <option value="json">JSON</option>
              <option value="raw">Raw</option>
              <option value="graphql">GraphQL</option>
              <option value="formUrlencoded">Form URL Encoded</option>
            </select>
          </div>

          {(bodyMode === 'json' || bodyMode === 'formUrlencoded') && (
            <StructuredInput
              label={bodyMode === 'json' ? 'Body' : 'Body Fields'}
              editorKey="http.body"
              value={node.data.body}
              mode={bodyInputMode}
              onModeChange={(mode) => patch({ bodyInputMode: mode })}
              onChange={(body) => patch({ body })}
              tokenWiring={tokenWiring}
              rows={7}
            />
          )}

          {bodyMode === 'raw' && (
            <>
              <div className="grid gap-2">
                <label className={labelClass}>Content Type</label>
                <input
                  aria-label="Raw body content type"
                  value={node.data.bodyContentType ?? 'text/plain'}
                  onChange={(event) => patch({ bodyContentType: event.target.value })}
                  className={controlClass}
                  placeholder="text/plain"
                />
              </div>
              <TokenTextEditor
                ref={registerEditor('http.body')}
                multiline
                rows={7}
                value={node.data.body ?? ''}
                labelCtx={labelCtx}
                onFocus={focusEditor('http.body')}
                onChange={(body) => patch({ body })}
                className={cn(tokenControlClass, 'font-mono text-xs')}
                placeholder="Raw request body"
                ariaLabel="Raw Body"
              />
            </>
          )}

          {bodyMode === 'graphql' && (
            <>
              <div className="grid gap-2">
                <label className={labelClass}>Query</label>
                <TokenTextEditor
                  ref={registerEditor('http.body')}
                  multiline
                  rows={7}
                  value={node.data.body ?? ''}
                  labelCtx={labelCtx}
                  onFocus={focusEditor('http.body')}
                  onChange={(body) => patch({ body })}
                  className={cn(tokenControlClass, 'font-mono text-xs')}
                  placeholder={'query GetThing($id: ID!) {\n  thing(id: $id) { id name }\n}'}
                  ariaLabel="GraphQL Query"
                />
              </div>
              <div className="grid gap-2">
                <label className={labelClass}>Variables (JSON)</label>
                <TokenTextEditor
                  ref={registerEditor('http.graphqlVariables')}
                  multiline
                  rows={4}
                  value={node.data.graphqlVariables ?? ''}
                  labelCtx={labelCtx}
                  onFocus={focusEditor('http.graphqlVariables')}
                  onChange={(graphqlVariables) => patch({ graphqlVariables })}
                  className={cn(tokenControlClass, 'font-mono text-xs')}
                  placeholder={'{\n  "id": "123"\n}'}
                  ariaLabel="GraphQL Variables JSON"
                />
              </div>
            </>
          )}
        </div>
      </ToggleSection>

      {!bodyAllowed && <p className="text-xs text-muted-foreground">The selected HTTP method does not send a request body.</p>}

      <AdvancedParamsSection node={node} onChange={update} />

      <Dialog open={credentialOpen} onOpenChange={setCredentialOpen}>
        <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{TYPE_LABELS[credentialType]}</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Save once, verify with a safe GET to this node&apos;s URL, then reuse it for matching endpoints.
            </p>
          </DialogHeader>
          <CredentialEditor
            initial={startCredentialDraft}
            verifyAgainst={node.data.url}
            onSaved={(credential) => {
              setCredentials((current) => [...current.filter((item) => item.id !== credential.id), credential])
              patch({ authMode: 'generic', credentialType: credential.type as CredentialType, credentialId: credential.id })
              setCredentialOpen(false)
            }}
            onCancel={() => setCredentialOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

// MISSING_HTTP_URL in validate.ts.
export const httpModule: NodeBodyModule = {
  Body: ({ node, toolCatalog, update, tokenWiring, showErrors, previewContext }: NodeBodyProps) => (
    <HttpBody node={node as HttpNode} toolCatalog={toolCatalog} update={update} tokenWiring={tokenWiring} showErrors={showErrors} previewContext={previewContext} />
  ),
  defaultEditorKey: 'http.url',
  requiredFields: ['url'],
}
