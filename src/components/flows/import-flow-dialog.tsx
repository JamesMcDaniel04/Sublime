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
import { cn } from '@/lib/utils'

type ImportReport = {
  source: 'sublime-portable' | 'sublime-download' | 'n8n'
  warnings: string[]
  stubbedNodes: Array<{ nodeId: string; label: string; originalType: string }>
  missingIntegrations: Array<{ nodeId: string; connectionId: string }>
  createdAgents: Array<{ id: string; title: string }>
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the user clicks "Open flow" on the success screen. */
  onImported: (flowId: string) => void
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
  const [result, setResult] = useState<{ flowId: string; name: string; report: ImportReport } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const reset = () => {
    setFileName(''); setDocument(''); setUrl(''); setPasted(''); setError(''); setResult(null); setSubmitting(false)
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

  const submit = async () => {
    const payload = tab === 'url' ? { url: url.trim() } : { document: tab === 'file' ? document : pasted }
    if (tab === 'url' ? !url.trim() : !(tab === 'file' ? document : pasted).trim()) {
      setError(tab === 'url' ? 'Enter a URL.' : tab === 'file' ? 'Choose a .json file.' : 'Paste the flow JSON.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch('/api/flows/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body.flow) {
        setError(body.error || 'The flow could not be imported.')
        return
      }
      setResult({ flowId: body.flow.id, name: body.flow.name, report: body.report })
    } catch {
      setError('The flow could not be imported.')
    } finally {
      setSubmitting(false)
    }
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
