'use client'

/**
 * Configure an agent's HTTP API endpoints — the agent-side twin of the flows
 * HTTP step. The editor IS the flows editor: `httpModule.Body` mounted on a
 * synthetic http node (same method/URL/auth-with-vault/headers/query/body
 * sections, cURL import included) plus the advanced options section. Dynamic
 * values use {{input.<name>}} placeholders; the detected placeholder list is
 * shown live, because those become the exact inputs the agent's model fills.
 */
import { useMemo, useState } from 'react'
import { Globe, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { httpModule } from '@/components/flows/nodes/http-body'
import { HttpOptionsSection } from '@/components/flows/nodes/http-options'
import type { TokenEditorWiring } from '@/components/flows/nodes/types'
import type { FlowNode } from '@/lib/flows/graph'
import {
  agentHttpToolInputs,
  agentHttpToolName,
  agentHttpToolSchema,
  MAX_AGENT_HTTP_TOOLS,
  type AgentHttpTool,
  type AgentHttpToolConfig,
} from '@/lib/agents/http-tools'

type HttpNode = Extract<FlowNode, { type: 'http' }>

/** Agent configs have no flow datatree — token insertion wiring is inert. */
const INERT_WIRING: TokenEditorWiring = {
  labelCtx: { stepLabels: {} },
  registerEditor: () => () => {},
  focusEditor: () => () => {},
  blockActive: () => {},
  unblockActive: () => {},
}

const EMPTY_CONFIG: AgentHttpToolConfig = { method: 'GET', url: '' }

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  tools: AgentHttpTool[]
  onChange: (tools: AgentHttpTool[]) => void
}

export function AgentHttpToolsDialog({ open, onOpenChange, tools, onChange }: Props) {
  const [editing, setEditing] = useState<AgentHttpTool | null>(null)

  const startNew = () => {
    setEditing({ id: `ep-${Date.now().toString(36)}`, name: '', description: '', config: { ...EMPTY_CONFIG } })
  }

  const remove = (id: string) => onChange(tools.filter((tool) => tool.id !== id))

  const save = () => {
    if (!editing) return
    const parsed = agentHttpToolSchema.safeParse(editing)
    if (!parsed.success) {
      toast.error(!editing.name.trim() ? 'Name this endpoint.' : 'The endpoint needs a URL.')
      return
    }
    const next = tools.some((tool) => tool.id === parsed.data.id)
      ? tools.map((tool) => (tool.id === parsed.data.id ? parsed.data : tool))
      : [...tools, parsed.data]
    onChange(next)
    setEditing(null)
  }

  const inputs = useMemo(() => (editing ? agentHttpToolInputs(editing.config) : []), [editing])
  const node: HttpNode | null = editing ? { id: 'agent-http', type: 'http', data: editing.config } : null

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setEditing(null) }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {editing && node ? (
          <>
            <DialogHeader>
              <DialogTitle>{tools.some((tool) => tool.id === editing.id) ? 'Edit API endpoint' : 'New API endpoint'}</DialogTitle>
              <DialogDescription>
                Same options as a flow HTTP step. Use {'{{input.name}}'} placeholders for values the agent should
                decide at call time — they become the tool&apos;s inputs.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ep-name">Name</Label>
                  <Input
                    id="ep-name"
                    placeholder="Create CRM lead"
                    value={editing.name}
                    onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Tool name</Label>
                  <p className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
                    {editing.name.trim() ? agentHttpToolName(editing) : 'http_…'}
                  </p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ep-desc">What this endpoint does</Label>
                <Textarea
                  id="ep-desc"
                  rows={2}
                  placeholder="Creates a lead in the CRM. Use when the user shares a new prospect."
                  value={editing.description}
                  onChange={(event) => setEditing({ ...editing, description: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">The agent reads this to decide when to call the endpoint.</p>
              </div>

              <div className="rounded-lg border p-3">
                <httpModule.Body
                  node={node}
                  agents={[]}
                  toolCatalog={[]}
                  update={(next) => setEditing({ ...editing, config: (next as HttpNode).data })}
                  tokenWiring={INERT_WIRING}
                />
              </div>

              <details className="rounded-lg border p-3">
                <summary className="cursor-pointer text-sm font-medium">Advanced options</summary>
                <div className="pt-2">
                  <HttpOptionsSection node={node} onChange={(next) => setEditing({ ...editing, config: (next as HttpNode).data })} />
                </div>
              </details>

              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                Agent-filled inputs:
                {inputs.length ? inputs.map((name) => <Badge key={name} variant="secondary" className="font-mono">{name}</Badge>) : <span>none — the request is fully fixed</span>}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)}>Back</Button>
              <Button onClick={save}>Save endpoint</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>HTTP API endpoints</DialogTitle>
              <DialogDescription>
                Give this agent real API access: each endpoint becomes a tool it can call, with credentials from
                your vault — never pasted into instructions.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              {tools.length === 0 && (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                  <Globe className="h-5 w-5" />
                  No endpoints yet — add the APIs this agent should be able to call.
                </div>
              )}
              {tools.map((tool) => (
                <div key={tool.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{tool.name}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {(tool.config.method ?? 'POST')} {tool.config.url}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(tool)} aria-label={`Edit ${tool.name}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(tool.id)} aria-label={`Remove ${tool.name}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
              <Button onClick={startNew} disabled={tools.length >= MAX_AGENT_HTTP_TOOLS}>
                <Plus className="mr-1.5 h-4 w-4" /> Add endpoint
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
