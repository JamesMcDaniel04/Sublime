import type { ReactNode } from 'react'
import type { FlowNode, OutputField } from '@/lib/flows/graph'
import type { TokenLabelContext } from '@/lib/flows/token-text'
import type { DataField } from '@/lib/flows/datatree'
import type { FlowContext } from '@/features/flows/context'
import type { TokenTextEditorHandle } from '../token-text-editor'
import type { ToolCatalog } from '../tool-catalog-type'
import type { EditableType } from '../node-types'

export type Agent = { id: string; title: string }
export type KeyValueRow = { key: string; value: string }
export type InputKind = 'text' | 'yesno' | 'file' | 'email' | 'number' | 'date'

/** One entry in the input-node type palette (icon included, hence a component ref). */
export type InputTypeDescriptor = {
  id: InputKind
  label: string
  description: string
  name: string
  fieldType: OutputField['type']
  icon: React.ComponentType<{ className?: string }>
  tone: string
}

/**
 * Wiring a body needs to participate in datatree token insertion: register a
 * chip-editor handle under a stable key, mark it focused, and block/unblock
 * inserts while a plain (non-token) input holds focus.
 */
export type TokenEditorWiring = {
  labelCtx: TokenLabelContext
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  blockActive: () => void
  unblockActive: () => void
}

/**
 * Everything any node body may need. Bodies destructure only what they use —
 * one prop bag keeps the registry's call site uniform, so adding a node type
 * never means touching the dispatch.
 */
export type NodeBodyProps = {
  node: FlowNode
  flowId?: string
  agents: Agent[]
  toolCatalog: ToolCatalog
  update: (node: FlowNode) => void
  onRefreshAgents?: () => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
  variableNames?: string[]
  dataFields?: DataField[]
  /**
   * Sample data for token previews (last run / pins / test input). Absent on a
   * flow with no data yet — bodies then render no preview rather than claiming
   * every token is broken.
   */
  previewContext?: FlowContext
  onAddStep?: (type: EditableType, branchIndex?: number) => void
}

/**
 * One node type's authoring surface.
 *
 * `defaultEditorKey` is where a datatree click lands when no chip editor has
 * been focused yet (the type's primary token field), and `requiredFields` names
 * the `node.data` keys that must be non-empty for the step to run — consumed by
 * the registry totality test now and by validation highlighting later.
 */
export type NodeBodyModule = {
  Body: (props: NodeBodyProps) => ReactNode
  defaultEditorKey?: string
  requiredFields: readonly string[]
}

export type { FlowNode, OutputField }
