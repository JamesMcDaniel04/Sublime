'use client'

import type { FlowNode } from '@/lib/flows/graph'
import type { DataField } from '@/lib/flows/datatree'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { ToolArgsEditor } from '../tool-args-editor'
import { SearchableSelect } from '../searchable-select'
import { ConnectionHealth } from './connection-health'
import { AdvancedParamsSection } from '../advanced-params'
import type { ToolCatalog } from '../tool-catalog-type'
import { labelClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function selectedTool(connectionId: string, toolName: string, toolCatalog: ToolCatalog) {
  const connection = toolCatalog.find((entry) => entry.id === connectionId)
  const tool = connection?.tools.find((entry) => entry.name === toolName)
  return { connection, tool }
}

function ToolBody({
  node,
  toolCatalog,
  update,
  showErrors,
  dataFields,
  tokenWiring,
  previewContext,
}: {
  node: Extract<FlowNode, { type: 'tool' }>
  toolCatalog: ToolCatalog
  update: (node: FlowNode) => void
  showErrors?: boolean
  dataFields: DataField[]
  tokenWiring: TokenEditorWiring
  previewContext?: NodeBodyProps['previewContext']
}) {
  const { connection, tool: liveTool } = selectedTool(node.data.connectionId, node.data.toolName, toolCatalog)
  const tool = liveTool ?? (node.data.actionInputSchema ? { name: node.data.toolName, description: node.data.actionDescription ?? '', inputSchema: node.data.actionInputSchema, outputSchema: node.data.actionOutputSchema, schemaHash: node.data.actionSchemaHash ?? '', risk: node.data.risk ?? 'read' as const } : undefined)
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Connection <span className="text-red-500">*</span></label>
        <SearchableSelect
          value={node.data.connectionId}
          ariaLabel="Connection"
          placeholder="Choose a connected tool"
          invalid={Boolean(showErrors && !node.data.connectionId)}
          emptyLabel="Connectors available on this workspace will show here."
          options={toolCatalog.map((entry) => ({ value: entry.id, label: entry.name }))}
          onChange={(connectionId) => {
            const nextConnection = toolCatalog.find((entry) => entry.id === connectionId)
            const selected = nextConnection?.tools[0]
            update({ ...node, data: { ...node.data, connectionId, toolName: selected?.name ?? '', actionDescription: selected?.description, actionInputSchema: selected?.inputSchema, actionOutputSchema: selected?.outputSchema, actionSchemaHash: selected?.schemaHash, risk: selected?.risk } })
          }}
        />
        <ConnectionHealth connectionId={node.data.connectionId || undefined} verification={connection?.verification} />
      </div>
      {connection && (
        <div className="grid gap-2">
          <label className={labelClass}>Action <span className="text-red-500">*</span></label>
          <SearchableSelect
            value={node.data.toolName}
            ariaLabel="Action"
            placeholder="Choose an action"
            invalid={Boolean(showErrors && !node.data.toolName)}
            // A connection whose discovery failed carries toolsError — say that
            // here rather than showing an empty list that reads as "still
            // loading". (Phase 3's verified-state chip replaces this stopgap.)
            emptyLabel={connection.toolsError ?? 'This connection reports no actions.'}
            options={connection.tools.map((entry) => ({ value: entry.name, label: entry.name, hint: entry.description }))}
            onChange={(toolName) => { const selected = connection.tools.find((entry) => entry.name === toolName); update({ ...node, data: { ...node.data, toolName, actionDescription: selected?.description, actionInputSchema: selected?.inputSchema, actionOutputSchema: selected?.outputSchema, actionSchemaHash: selected?.schemaHash, risk: selected?.risk } }) }}
          />
        </div>
      )}
      {connection ? (
        <div className="flex items-start gap-3 rounded-lg bg-muted p-3 text-sm text-muted-foreground">
          <IntegrationLogo slug={connection.id} name={connection.name} className="h-8 w-8 rounded-lg bg-white p-1" />
          <p>{tool ? tool.description || 'Runs this exact tool with the arguments below.' : 'Choose the action this connection should run.'}</p>
        </div>
      ) : (
        <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">Connectors available on this workspace will show here.</p>
      )}
      {node.data.toolName && (
        <ToolArgsEditor
          previewContext={previewContext}
          inputSchema={tool?.inputSchema}
          args={node.data.args}
          onChange={(nextArgs) => update({ ...node, data: { ...node.data, args: nextArgs } })}
          dataFields={dataFields}
          labelCtx={tokenWiring.labelCtx}
        />
      )}
      {node.data.risk && node.data.risk !== 'read' && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">This action is classified as {node.data.risk} — it performs an external write when the flow runs.</p>}
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

// MISSING_TOOL_CONNECTION + MISSING_TOOL in validate.ts.
export const toolModule: NodeBodyModule = {
  Body: ({ node, toolCatalog, update, showErrors, dataFields, tokenWiring, previewContext }: NodeBodyProps) => (
    <ToolBody node={node as Extract<FlowNode, { type: 'tool' }>} toolCatalog={toolCatalog} update={update} showErrors={showErrors} dataFields={dataFields ?? []} tokenWiring={tokenWiring} previewContext={previewContext} />
  ),
  requiredFields: ['connectionId', 'toolName'],
}
