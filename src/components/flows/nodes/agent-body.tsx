'use client'

import { useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FIELD_TYPES, type FlowNode, type OutputField } from '@/lib/flows/graph'
import { TokenTextEditor } from '../token-text-editor'
import { AdvancedParamsSection } from '../advanced-params'
import { controlClass, labelClass, tokenControlClass } from './field-primitives'
import type { Agent, NodeBodyModule, NodeBodyProps, TokenEditorWiring } from './types'

function defaultAgentInput(value?: string): boolean {
  const trimmed = (value ?? '').trim()
  return trimmed === 'Use this flow input:\n{{trigger.input}}' || trimmed === 'Process this item:\n{{item}}'
}

function AgentBody({
  node,
  agents,
  update,
  onRefreshAgents,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'agent' }>
  agents: Agent[]
  update: (node: FlowNode) => void
  onRefreshAgents?: () => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const isDefaultInput = defaultAgentInput(node.data.input)
  const responseFormat = node.data.responseFormat ?? 'text'
  const outputFields = node.data.outputFields ?? []
  const setOutputFields = (fields: OutputField[]) =>
    update({ ...node, data: { ...node.data, outputFields: fields.length ? fields : undefined } })
  // Inline-prompt mode: an ephemeral one-shot model call with no saved
  // AgentTask (model-runner.ts's generateText). Opens by default when the
  // node already carries a prompt (JSON/copilot-authored), otherwise the
  // saved-agent picker stays the default surface.
  const [showInlinePrompt, setShowInlinePrompt] = useState(Boolean(node.data.prompt?.trim()))
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Agent <span className="text-red-500">*</span></label>
        <div className="flex items-center gap-2">
          <select
            value={node.data.agentId}
            onChange={(event) => update({ ...node, data: { ...node.data, agentId: event.target.value } })}
            className={cn(controlClass, 'min-w-0 flex-1', showErrors && !node.data.agentId && 'border-red-400 focus:border-red-500')}
          >
            <option value="">Choose an agent</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.title}
              </option>
            ))}
          </select>
          {onRefreshAgents && (
            <button
              type="button"
              onClick={onRefreshAgents}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Refresh agent list"
              title="Refresh agent list"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          )}
          <a
            href="/agents"
            target="_blank"
            rel="noreferrer"
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-semibold text-muted-foreground hover:bg-muted"
            title="Create a new agent on the dashboard"
          >
            <Plus className="h-4 w-4" /> New
          </a>
        </div>
        <button
          type="button"
          onClick={() => setShowInlinePrompt((value) => !value)}
          className="w-fit text-xs font-semibold text-blue-700 hover:text-blue-900"
        >
          {showInlinePrompt ? 'Hide inline prompt' : 'Use an inline prompt instead of a saved agent'}
        </button>
      </div>
      {showInlinePrompt && (
        <div className="grid gap-3 rounded-lg border border-border bg-muted p-3">
          <div className="grid gap-2">
            <label className={labelClass}>Prompt</label>
            <TokenTextEditor
              ref={registerEditor('agent.prompt')}
              multiline
              rows={4}
              value={node.data.prompt ?? ''}
              labelCtx={labelCtx}
              onFocus={focusEditor('agent.prompt')}
              onChange={(prompt) => update({ ...node, data: { ...node.data, prompt: prompt || undefined } })}
              className={tokenControlClass}
              placeholder="Run this prompt as a one-shot model call — no saved agent needed."
              ariaLabel="Inline prompt"
            />
          </div>
          <div className="grid gap-2">
            <label className={labelClass}>Model</label>
            <select
              value={node.data.model ?? ''}
              onChange={(event) => update({ ...node, data: { ...node.data, model: event.target.value || undefined } })}
              className={cn(controlClass, 'w-full sm:w-64')}
            >
              <option value="">Default</option>
              <option value="claude-opus-4-8">Claude Opus 4.8</option>
              <option value="claude-sonnet-5">Claude Sonnet 5</option>
              <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
              <option value="qwen-3.7">Qwen 3.7</option>
            </select>
          </div>
        </div>
      )}
      <div className="grid gap-2">
        <label className={labelClass}>Message to agent</label>
        <TokenTextEditor
          ref={registerEditor('agent.input')}
          multiline
          rows={4}
          value={isDefaultInput ? '' : node.data.input ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('agent.input')}
          onChange={(input) => update({ ...node, data: { ...node.data, input } })}
          className={tokenControlClass}
          placeholder={isDefaultInput ? 'Uses the trigger input by default. Add instructions here if needed.' : 'Tell the agent what to do at this step.'}
          ariaLabel="Message to agent"
        />
      </div>
      <div className="flex items-start justify-between gap-3 rounded-lg bg-muted p-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Request human assistance when unsure</p>
          <p className="mt-0.5 text-xs text-muted-foreground">When the agent isn&apos;t sure how to proceed, the flow pauses and asks for input.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={node.data.humanAssistance !== false}
          aria-label="Request human assistance when unsure"
          onClick={() => update({ ...node, data: { ...node.data, humanAssistance: node.data.humanAssistance === false ? undefined : false } })}
          className={cn(
            'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors',
            node.data.humanAssistance !== false ? 'bg-blue-600' : 'bg-muted-foreground/30',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-background shadow transition-all',
              node.data.humanAssistance !== false ? 'left-[22px]' : 'left-0.5',
            )}
          />
        </button>
      </div>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <label className={labelClass}>Agent response</label>
          <select
            value={responseFormat}
            onChange={(event) =>
              update({ ...node, data: { ...node.data, responseFormat: event.target.value === 'structured' ? 'structured' : undefined } })
            }
            className="h-8 rounded-md border border-border bg-background px-2 text-xs font-semibold text-muted-foreground outline-none"
          >
            <option value="text">Text only</option>
            <option value="structured">Structured</option>
          </select>
        </div>
        <p className="text-xs text-muted-foreground">
          {responseFormat === 'structured'
            ? 'The agent must reply with JSON matching these properties; each becomes data for later steps.'
            : 'The agent replies with plain text. Switch to Structured to map fields into later steps.'}
        </p>
        {responseFormat === 'structured' && (
          <div className="space-y-2">
            {outputFields.map((field, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_120px_36px]">
                <input
                  value={field.name}
                  onChange={(event) => setOutputFields(outputFields.map((entry, j) => (j === index ? { ...entry, name: event.target.value } : entry)))}
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  className={controlClass}
                  placeholder="propertyName"
                />
                <select
                  value={field.type}
                  onChange={(event) => setOutputFields(outputFields.map((entry, j) => (j === index ? { ...entry, type: event.target.value as OutputField['type'] } : entry)))}
                  className={controlClass}
                >
                  {FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setOutputFields(outputFields.filter((_, j) => j !== index))}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove property"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setOutputFields([...outputFields, { name: '', type: 'string' }])}
              className="text-sm font-semibold text-blue-700 hover:text-blue-900"
            >
              Add property
            </button>
          </div>
        )}
      </div>
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

// MISSING_AGENT_OR_PROMPT in validate.ts: a saved agent OR an inline prompt.
export const agentModule: NodeBodyModule = {
  Body: ({ node, agents, update, onRefreshAgents, tokenWiring, showErrors }: NodeBodyProps) => (
    <AgentBody node={node as Extract<FlowNode, { type: 'agent' }>} agents={agents} update={update} onRefreshAgents={onRefreshAgents} tokenWiring={tokenWiring} showErrors={showErrors} />
  ),
  defaultEditorKey: 'agent.input',
  requiredFields: ['agentId'],
}
