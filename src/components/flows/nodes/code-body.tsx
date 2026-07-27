'use client'

import type { FlowNode } from '@/lib/flows/graph'
import { CODE_SNIPPETS, isDefaultSnippet, type CodeLanguage, type CodeMode } from '@/lib/flows/code-snippets'
import { controlClass, labelClass } from './field-primitives'
import type { NodeBodyModule, NodeBodyProps } from './types'

type CodeNode = Extract<FlowNode, { type: 'code' }>

/**
 * The Code step's params pane — n8n's shape: Mode, Language, the editor, and
 * a per-language hint. Deliberately a plain monospace textarea rather than an
 * embedded code editor: the NDV's input pane already carries the data being
 * worked on, and a dependency-free editor keeps the modal light.
 *
 * Switching language or mode swaps the starter snippet ONLY while the code is
 * still an untouched default (isDefaultSnippet) — a user's edit is never
 * clobbered by a select change, n8n's own behaviour.
 */
function CodeBody({ node, update }: { node: CodeNode; update: (node: FlowNode) => void }) {
  const patch = (data: Partial<CodeNode['data']>) => update({ ...node, data: { ...node.data, ...data } })
  const language = node.data.language
  const mode = node.data.mode

  const retarget = (nextLanguage: CodeLanguage, nextMode: CodeMode) => ({
    language: nextLanguage,
    mode: nextMode,
    ...(isDefaultSnippet(node.data.code) ? { code: CODE_SNIPPETS[nextLanguage][nextMode] } : {}),
  })

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 pb-16">
      <div className="grid gap-2">
        <label className={labelClass}>Mode</label>
        <select
          aria-label="Mode"
          value={mode}
          onChange={(event) => patch(retarget(language, event.target.value as CodeMode))}
          className={controlClass}
        >
          <option value="allItems">Run Once for All Items</option>
          <option value="eachItem">Run Once for Each Item</option>
        </select>
      </div>

      <div className="grid gap-2">
        <label className={labelClass}>Language</label>
        <select
          aria-label="Language"
          value={language}
          onChange={(event) => patch(retarget(event.target.value as CodeLanguage, mode))}
          className={controlClass}
        >
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
        </select>
      </div>

      <div className="grid gap-2">
        <label className={labelClass}>{language === 'python' ? 'Python' : 'JavaScript'}</label>
        <textarea
          aria-label="Code"
          value={node.data.code}
          onChange={(event) => patch({ code: event.target.value })}
          rows={14}
          spellCheck={false}
          className="w-full rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-blue-500"
        />
      </div>

      <p className="rounded-md border border-amber-200/60 bg-amber-50 p-2.5 text-xs leading-5 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
        {language === 'python' ? (
          <>
            Your code runs with <code className="font-mono">_items</code> (all input items)
            {mode === 'eachItem' && <> and <code className="font-mono">_item</code> (the current item)</>};
            end with a <code className="font-mono">return</code>. Debug with print() — its output appears under Logs when you test the step.
            Python runs sandboxed without <code className="font-mono">await</code> or package imports.
          </>
        ) : (
          <>
            Your code runs with <code className="font-mono">$input.all()</code>
            {mode === 'eachItem' && <>, <code className="font-mono">$input.item</code></>} and plain{' '}
            <code className="font-mono">items</code>{mode === 'eachItem' && <> / <code className="font-mono">item</code></>};
            end with a <code className="font-mono">return</code>. Debug with console.log() — its output appears under
            Logs when you test the step. <code className="font-mono">await</code> is supported.
          </>
        )}
      </p>

    </div>
  )
}

// MISSING_CODE in validate.ts.
export const codeModule: NodeBodyModule = {
  Body: ({ node, update }: NodeBodyProps) => <CodeBody node={node as CodeNode} update={update} />,
  requiredFields: ['code'],
}
