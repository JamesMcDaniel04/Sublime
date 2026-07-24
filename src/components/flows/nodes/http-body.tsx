'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { FlowNode } from '@/lib/flows/graph'
import { parseCurlCommand } from '@/lib/flows/curl-import'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { TokenTextEditor } from '../token-text-editor'
import { AdvancedParamsSection } from '../advanced-params'
import type { ToolCatalog } from '../tool-catalog-type'
import { InlineKeyValue } from './inline-key-value'
import { controlClass, labelClass, tokenControlBase, tokenControlClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function HttpBody({
  node,
  toolCatalog,
  update,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'http' }>
  toolCatalog: ToolCatalog
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const urlInvalid = Boolean(showErrors && !node.data.url)
  const authConnections = toolCatalog.filter((entry) => parseFlowToolConnectionId(entry.id).plane === 'mcp')
  const [curlOpen, setCurlOpen] = useState(false)
  const [curlText, setCurlText] = useState('')
  const [curlError, setCurlError] = useState<string | null>(null)
  const auth = node.data.auth
  const patchAuth = (values: Record<string, string | undefined>) =>
    update({ ...node, data: { ...node.data, auth: { ...(node.data.auth ?? { type: 'basic' }), ...values } as typeof node.data.auth } })
  const importCurl = () => {
    try {
      const imported = parseCurlCommand(curlText)
      update({ ...node, data: { ...node.data, ...imported } })
      setCurlOpen(false)
      setCurlText('')
      setCurlError(null)
    } catch (error) {
      setCurlError(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          aria-label="Import cURL"
          onClick={() => { setCurlOpen((value) => !value); setCurlError(null) }}
          className="rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted"
        >
          Import cURL
        </button>
      </div>
      {curlOpen && (
        <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-3">
          <label className={labelClass}>Paste a cURL command</label>
          <textarea
            aria-label="cURL command"
            rows={3}
            value={curlText}
            onChange={(event) => setCurlText(event.target.value)}
            className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground outline-none focus:border-blue-500"
            placeholder="curl -X POST https://api.example.com -H 'Content-Type: application/json' --data '{...}'"
          />
          {curlError && <p className="text-xs text-red-500">{curlError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setCurlOpen(false); setCurlError(null) }} className="rounded-md px-2.5 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground">
              Cancel
            </button>
            <button type="button" aria-label="Apply cURL import" onClick={importCurl} className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted">
              Import
            </button>
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
        <div className="grid gap-2">
          <label className={labelClass}>URI <span className="text-red-500">*</span></label>
          <TokenTextEditor
            ref={registerEditor('http.url')}
            value={node.data.url}
            labelCtx={labelCtx}
            onFocus={focusEditor('http.url')}
            onChange={(url) => update({ ...node, data: { ...node.data, url } })}
            invalid={urlInvalid}
            className={cn(tokenControlBase, urlInvalid ? 'focus:border-red-500' : 'border-border')}
            placeholder="https://api.example.com/endpoint"
            ariaLabel="URI"
          />
        </div>
        <div className="grid gap-2">
          <label className={labelClass}>Method <span className="text-red-500">*</span></label>
          <select
            value={node.data.method}
            onChange={(event) => update({ ...node, data: { ...node.data, method: event.target.value as typeof node.data.method } })}
            className={controlClass}
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </div>
      </div>
      <InlineKeyValue
        label="Headers"
        editorKey="http.headers"
        value={node.data.headers}
        onChange={(headers) => update({ ...node, data: { ...node.data, headers } })}
        tokenWiring={tokenWiring}
      />
      <div className="grid gap-2">
        <label className={labelClass}>Authenticate with (optional)</label>
        <select
          value={node.data.connectionId ?? ''}
          onChange={(event) => update({ ...node, data: { ...node.data, connectionId: event.target.value || undefined } })}
          className={controlClass}
        >
          <option value="">No authentication</option>
          {authConnections.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Uses this connection&apos;s login to authorize the request — connections shared with your workspace, plus your own. Your own Authorization header always takes precedence.
        </p>
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Generic auth (optional)</label>
        <select
          aria-label="Generic auth type"
          value={auth?.type ?? ''}
          onChange={(event) => {
            const type = event.target.value
            update({ ...node, data: { ...node.data, auth: type ? { type: type as NonNullable<typeof node.data.auth>['type'] } : undefined } })
          }}
          className={controlClass}
        >
          <option value="">None</option>
          <option value="basic">Basic (username + password)</option>
          <option value="bearer">Bearer token</option>
          <option value="header">Custom header</option>
          <option value="query">Query parameter</option>
        </select>
        {auth?.type === 'basic' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <TokenTextEditor ref={registerEditor('http.auth.username')} value={auth.username ?? ''} labelCtx={labelCtx} onFocus={focusEditor('http.auth.username')} onChange={(username) => patchAuth({ username })} className={tokenControlClass} placeholder="Username" ariaLabel="Auth username" />
            <TokenTextEditor ref={registerEditor('http.auth.password')} value={auth.password ?? ''} labelCtx={labelCtx} onFocus={focusEditor('http.auth.password')} onChange={(password) => patchAuth({ password })} className={tokenControlClass} placeholder="Password" ariaLabel="Auth password" />
          </div>
        )}
        {auth?.type === 'bearer' && (
          <TokenTextEditor ref={registerEditor('http.auth.token')} value={auth.token ?? ''} labelCtx={labelCtx} onFocus={focusEditor('http.auth.token')} onChange={(token) => patchAuth({ token })} className={tokenControlClass} placeholder="Token" ariaLabel="Auth token" />
        )}
        {(auth?.type === 'header' || auth?.type === 'query') && (
          <div className="grid gap-2 sm:grid-cols-2">
            <TokenTextEditor ref={registerEditor('http.auth.name')} value={auth.name ?? ''} labelCtx={labelCtx} onFocus={focusEditor('http.auth.name')} onChange={(name) => patchAuth({ name })} className={tokenControlClass} placeholder={auth.type === 'header' ? 'Header name (e.g. X-Api-Key)' : 'Parameter name (e.g. api_key)'} ariaLabel="Auth name" />
            <TokenTextEditor ref={registerEditor('http.auth.value')} value={auth.value ?? ''} labelCtx={labelCtx} onFocus={focusEditor('http.auth.value')} onChange={(value) => patchAuth({ value })} className={tokenControlClass} placeholder="Value" ariaLabel="Auth value" />
          </div>
        )}
        {auth && (
          <p className="text-xs text-muted-foreground">
            Secrets in this section are hidden in run history. An explicit Authorization header wins over this auth; Basic/Bearer set here wins over a connection selected above.
          </p>
        )}
      </div>
      <InlineKeyValue
        label="Queries"
        editorKey="http.query"
        value={node.data.query}
        onChange={(query) => update({ ...node, data: { ...node.data, query } })}
        tokenWiring={tokenWiring}
      />
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2"><label className={labelClass}>Body</label><select className="h-8 rounded-md border border-border bg-background px-2 text-xs" value={node.data.bodyMode ?? 'json'} onChange={(event) => update({ ...node, data: { ...node.data, bodyMode: event.target.value as typeof node.data.bodyMode } })}><option value="json">JSON</option><option value="text">Text</option><option value="raw">Raw</option><option value="formUrlencoded">Form URL encoded</option><option value="multipart">Multipart form</option><option value="binary">Binary (base64)</option><option value="none">No body</option></select></div>
        <TokenTextEditor
          ref={registerEditor('http.body')}
          multiline
          rows={4}
          value={node.data.body ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('http.body')}
          onChange={(body) => update({ ...node, data: { ...node.data, body } })}
          className={tokenControlClass}
          placeholder="Optional JSON or text body for POST, PUT, and PATCH requests."
          ariaLabel="Body"
        />
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Cookie</label>
        <TokenTextEditor
          ref={registerEditor('http.cookie')}
          value={node.data.cookie ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('http.cookie')}
          onChange={(cookie) => update({ ...node, data: { ...node.data, cookie: cookie || undefined } })}
          className={tokenControlClass}
          placeholder="name=value; other=value"
          ariaLabel="Cookie"
        />
      </div>
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

// MISSING_HTTP_URL in validate.ts.
export const httpModule: NodeBodyModule = {
  Body: ({ node, toolCatalog, update, tokenWiring, showErrors }: NodeBodyProps) => (
    <HttpBody node={node as Extract<FlowNode, { type: 'http' }>} toolCatalog={toolCatalog} update={update} tokenWiring={tokenWiring} showErrors={showErrors} />
  ),
  defaultEditorKey: 'http.body',
  requiredFields: ['url'],
}
