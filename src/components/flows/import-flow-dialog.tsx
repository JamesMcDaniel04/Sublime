'use client'

/**
 * Import a flow from a .json file, a URL, or pasted JSON (n8n-style import).
 * The file is read CLIENT-side (it's just JSON text) so the API stays plain
 * JSON — no multipart. After a successful import the report (warnings, n8n
 * stub steps, missing integrations) is shown before navigating, so nothing
 * about the conversion is silently dropped.
 */
import { useRef, useState } from 'react'
import { AlertTriangle, FileJson, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { CredentialPicker } from '@/components/credentials/credential-picker'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { CredentialGroup } from '@/lib/import/types'
import type { CredentialDraft } from '@/lib/credentials/form'

type ImportReport = {
  source: 'sublime-portable' | 'sublime-download' | 'n8n'
  warnings: string[]
  stubbedNodes: Array<{ nodeId: string; label: string; originalType: string }>
  missingIntegrations: Array<{ nodeId: string; connectionId: string }>
  createdAgents: Array<{ id: string; title: string }>
  additionalFlows?: Array<{ id: string; name: string }>
  credentialGroups?: CredentialGroup[]
}

/**
 * Create-form prefill from the import's credential mapping — the integration's
 * real header/query names, never secret values. Built conditionally so an
 * absent suggestion can't override the picker's hostname-derived defaults.
 */
function groupDraftSeed(group: CredentialGroup): Partial<CredentialDraft> | undefined {
  const seed: Partial<CredentialDraft> = {}
  if (group.sourceDisplayName) seed.name = `${group.sourceDisplayName} (imported)`
  if (group.suggestedHeaderName) seed.headerName = group.suggestedHeaderName
  if (group.suggestedQueryParam) seed.queryParam = group.suggestedQueryParam
  if (group.suggestedEntries?.length) {
    const rows = (kind: 'header' | 'query') =>
      group.suggestedEntries!.filter((entry) => entry.kind === kind).map((entry) => ({ name: entry.name, value: '' }))
    const headers = rows('header')
    const query = rows('query')
    // Keep the editor's trailing blank row so its add-row affordance survives.
    if (headers.length) seed.headers = [...headers, { name: '', value: '' }]
    if (query.length) seed.query = [...query, { name: '', value: '' }]
  }
  return Object.keys(seed).length ? seed : undefined
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called from the success screen; `demo` asks the builder to open the
   *  Copilot and run a sample-data preview of the imported flow. */
  onImported: (flowId: string, options?: { demo?: boolean }) => void
}

const MAX_FILE_BYTES = 2 * 1024 * 1024

export function ImportFlowDialog({ open, onOpenChange, onImported }: Props) {
  const [tab, setTab] = useState('file')
  const [fileName, setFileName] = useState('')
  const [document, setDocument] = useState('')
  const [url, setUrl] = useState('')
  const [pasted, setPasted] = useState('')
  const [dragging, setDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ flowId: string; name: string; graph: unknown; updatedAt?: string; report: ImportReport } | null>(null)
  const [boundGroups, setBoundGroups] = useState<Record<string, string>>({})
  /** Set when the same document was imported before — offers update vs copy. */
  const [conflict, setConflict] = useState<{ payload: Record<string, unknown>; message: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const reset = () => {
    setFileName(''); setDocument(''); setUrl(''); setPasted(''); setError(''); setResult(null); setSubmitting(false); setBoundGroups({}); setConflict(null)
  }

  /**
   * Bulk credential binding: steps that shared one credential in the source
   * system get the chosen vault credential in a single save, instead of
   * opening each step's auth section by hand.
   */
  const bindCredentialGroup = async (
    group: NonNullable<ImportReport['credentialGroups']>[number],
    credentialId: string,
    credentialType: string,
  ) => {
    if (!result) return
    const graph = result.graph as { nodes?: Array<{ id: string; type: string; data: Record<string, unknown> }> }
    const members = new Set(group.nodeIds)
    const nextGraph = {
      ...graph,
      nodes: (graph.nodes ?? []).map((node) =>
        members.has(node.id) && node.type === 'http'
          ? { ...node, data: { ...node.data, authMode: 'generic', credentialType, credentialId } }
          : node,
      ),
    }
    try {
      const response = await fetch('/api/flows', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: result.flowId, graph: nextGraph, ...(result.updatedAt ? { baseUpdatedAt: result.updatedAt } : {}) }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body.flow) {
        toast.error(body.error || 'Could not attach the credential to the imported steps.')
        return
      }
      setResult({ ...result, graph: body.flow.graph ?? nextGraph, updatedAt: body.flow.updatedAt })
      setBoundGroups((prev) => ({ ...prev, [group.key]: credentialId }))
      const httpMembers = (graph.nodes ?? []).filter((node) => members.has(node.id) && node.type === 'http').length
      toast.success(`Credential attached to ${httpMembers} step${httpMembers === 1 ? '' : 's'}.`)
    } catch {
      toast.error('Could not attach the credential — check your connection.')
    }
  }

  const readFile = async (file: File) => {
    setError('')
    if (file.size > MAX_FILE_BYTES) {
      setError('That file is larger than 2 MB.')
      return
    }
    setFileName(file.name)
    setDocument(await file.text())
  }

  const submitPayload = async (payload: Record<string, unknown>) => {
    setSubmitting(true)
    setError('')
    setConflict(null)
    try {
      const response = await fetch('/api/flows/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (response.status === 409 && body.code === 'ALREADY_IMPORTED') {
        setConflict({ payload, message: body.error || 'This flow was already imported.' })
        return
      }
      if (!response.ok || !body.flow) {
        setError(body.error || 'The flow could not be imported.')
        return
      }
      setResult({ flowId: body.flow.id, name: body.flow.name, graph: body.flow.graph, updatedAt: body.flow.updatedAt, report: body.report })
    } catch {
      setError('The flow could not be imported.')
    } finally {
      setSubmitting(false)
    }
  }

  const submit = async () => {
    const payload = tab === 'url' ? { url: url.trim() } : { document: tab === 'file' ? document : pasted }
    if (tab === 'url' ? !url.trim() : !(tab === 'file' ? document : pasted).trim()) {
      setError(tab === 'url' ? 'Enter a URL.' : tab === 'file' ? 'Choose a .json file.' : 'Paste the flow JSON.')
      return
    }
    await submitPayload(payload)
  }

  const report = result?.report
  const noteworthy = Boolean(report && (report.warnings.length || report.stubbedNodes.length || report.missingIntegrations.length))

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) reset() }}>
      <DialogContent className="sm:max-w-lg">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>Imported “{result.name}”</DialogTitle>
              <DialogDescription>
                The flow was created as a private draft{report?.createdAgents.length ? `, along with ${report.createdAgents.length} agent${report.createdAgents.length === 1 ? '' : 's'} it uses` : ''}.
              </DialogDescription>
            </DialogHeader>
            {(report?.credentialGroups?.length ?? 0) > 0 && (
              <div className="space-y-2 rounded-lg border p-3 text-sm">
                <p className="font-medium">Attach credentials</p>
                <p className="text-xs text-muted-foreground">
                  These steps shared credentials in n8n. Pick (or create) a vault credential once per group — it applies to every step in the group.
                </p>
                {report!.credentialGroups!.map((group) => (
                  <div key={group.key} className="flex items-center gap-3 rounded-md border border-border/60 px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{group.sourceDisplayName ?? group.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {group.nodeIds.length} step{group.nodeIds.length === 1 ? '' : 's'} · {group.sourceType}
                      </p>
                    </div>
                    {group.unsupported || !group.credentialType ? (
                      <p className="w-56 shrink-0 text-[11px] text-muted-foreground">
                        <AlertTriangle className="mr-1 inline h-3 w-3 text-amber-500" aria-hidden />
                        {group.sourceDisplayName ?? group.name} can&apos;t be reproduced with a generic credential — n8n
                        authenticates it programmatically. Connect the integration, or open the step and configure auth manually.
                      </p>
                    ) : (
                      <div className="w-56 shrink-0">
                        <CredentialPicker
                          value={boundGroups[group.key]}
                          type={group.credentialType}
                          context="http"
                          draftSeed={groupDraftSeed(group)}
                          onChange={(credentialId, nextType) => {
                            if (credentialId) void bindCredentialGroup(group, credentialId, nextType ?? group.credentialType ?? 'bearer')
                          }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {(report?.additionalFlows?.length ?? 0) > 0 && (
              <div className="rounded-lg border p-3 text-sm">
                <p className="font-medium">Also created</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The n8n workflow had multiple triggers, so it became one flow per trigger:
                </p>
                <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                  {report!.additionalFlows!.map((sibling) => <li key={sibling.id}>{sibling.name}</li>)}
                </ul>
              </div>
            )}
            {noteworthy && report && (
              <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border bg-muted/40 p-3 text-sm">
                {report.stubbedNodes.length > 0 && (
                  <div>
                    <p className="font-medium">Steps imported as HTTP placeholders</p>
                    <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                      {report.stubbedNodes.map((stub) => (
                        <li key={stub.nodeId}>{stub.label} <span className="text-xs">({stub.originalType})</span></li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.missingIntegrations.length > 0 && (
                  <div>
                    <p className="font-medium">Connections to set up</p>
                    <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                      {report.missingIntegrations.map((missing) => (
                        <li key={missing.nodeId}>{missing.connectionId}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.warnings.length > 0 && (
                  <div>
                    <p className="font-medium">Review after import</p>
                    <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                      {report.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
              <Button variant="outline" onClick={() => onImported(result.flowId, { demo: true })}>
                Preview with sample data
              </Button>
              <Button onClick={() => onImported(result.flowId)}>Open flow</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Import a flow</DialogTitle>
              <DialogDescription>
                Bring in a Sublime flow export or an n8n workflow — from a JSON file, a URL, or pasted JSON.
              </DialogDescription>
            </DialogHeader>
            <Tabs value={tab} onValueChange={(next) => { setTab(next); setError('') }}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="file">Upload file</TabsTrigger>
                <TabsTrigger value="url">From URL</TabsTrigger>
                <TabsTrigger value="paste">Paste JSON</TabsTrigger>
              </TabsList>
              <TabsContent value="file" className="pt-3">
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault()
                    setDragging(false)
                    const file = event.dataTransfer.files?.[0]
                    if (file) void readFile(file)
                  }}
                  className={cn(
                    'flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-sm text-muted-foreground transition-colors',
                    dragging ? 'border-primary bg-primary/5' : 'hover:border-muted-foreground/50',
                  )}
                >
                  {fileName ? (
                    <><FileJson className="h-6 w-6" /><span className="font-medium text-foreground">{fileName}</span><span>Click to choose a different file</span></>
                  ) : (
                    <><Upload className="h-6 w-6" /><span>Drop a .json file here, or click to browse</span></>
                  )}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void readFile(file)
                    event.target.value = ''
                  }}
                />
              </TabsContent>
              <TabsContent value="url" className="space-y-2 pt-3">
                <Label htmlFor="import-url">Public URL of the workflow JSON</Label>
                <Input
                  id="import-url"
                  placeholder="https://example.com/workflow.json"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </TabsContent>
              <TabsContent value="paste" className="space-y-2 pt-3">
                <Label htmlFor="import-paste">Workflow JSON</Label>
                <Textarea
                  id="import-paste"
                  rows={8}
                  placeholder='{"format":"sublime.flow", …} or {"nodes":[…],"connections":{…}}'
                  value={pasted}
                  onChange={(event) => setPasted(event.target.value)}
                  className="font-mono text-xs"
                />
              </TabsContent>
            </Tabs>
            {error && (
              <p className="flex items-start gap-1.5 text-sm text-red-600">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
              </p>
            )}
            {conflict && (
              <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-100">
                <p>{conflict.message}</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void submitPayload({ ...conflict.payload, mode: 'update' })} loading={submitting}>
                    Update existing flow
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void submitPayload({ ...conflict.payload, mode: 'new' })} disabled={submitting}>
                    Create a copy
                  </Button>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => void submit()} loading={submitting}>Import</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
