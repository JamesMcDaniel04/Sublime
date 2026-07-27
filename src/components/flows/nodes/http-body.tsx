'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import { parseCurlCommand } from '@/lib/flows/curl-import'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import type { CredentialType } from '@/lib/credentials/types'
import { CredentialPicker } from '@/components/credentials/credential-picker'
import { Switch } from '@/components/ui/switch'
import { TokenTextEditor } from '../token-text-editor'
import type { ToolCatalog } from '../tool-catalog-type'
import { InlineKeyValue } from './inline-key-value'
import { controlClass, labelClass, tokenControlBase, tokenControlClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'
import { FieldPreview } from './field-preview'

type HttpNode = Extract<FlowNode, { type: 'http' }>
/**
 * Methods where fetch refuses a body. Every other method may carry one — n8n
 * offers Send Body on all of them, and silently hiding it for DELETE/OPTIONS
 * blocked legitimate requests.
 */
const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

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
  const [curlOpen, setCurlOpen] = useState(false)
  const [curlText, setCurlText] = useState('')
  const [curlError, setCurlError] = useState<string | null>(null)

  const patch = (data: Partial<HttpNode['data']>) => update({ ...node, data: { ...node.data, ...data } })
  const urlInvalid = Boolean(showErrors && !node.data.url)
  const authConnections = toolCatalog.filter((entry) => parseFlowToolConnectionId(entry.id).plane === 'mcp')
  const credentialType = (node.data.credentialType ?? 'basic') as CredentialType
  const bodyAllowed = !BODYLESS_METHODS.has(node.data.method)
  const sendQuery = node.data.sendQuery ?? Boolean(node.data.query?.trim())
  const sendHeaders = node.data.sendHeaders ?? Boolean(node.data.headers?.trim())
  // The toggle stays operable on GET/HEAD so the configuration survives a
  // method switch; the warning below explains why nothing will be sent.
  const sendBody = node.data.sendBody ?? Boolean(node.data.body?.trim())
  const bodyBlocked = sendBody && !bodyAllowed
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
          <CredentialPicker
            value={node.data.credentialId}
            type={credentialType}
            verifyAgainst={node.data.url}
            context="http"
            onChange={(credentialId, nextType) => patch({ authMode: 'generic', credentialId, credentialType: nextType })}
          />
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
      >
        <div className="grid gap-3">
          {bodyBlocked && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
              {node.data.method} requests cannot carry a body — this step will fail until you switch the method
              (GraphQL and JSON bodies normally use POST) or turn Send Body off.
            </p>
          )}
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
