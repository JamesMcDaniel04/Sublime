'use client'

import { useMemo, useState } from 'react'
import { EXPRESSION_FUNCTIONS, type ExpressionFunctionGroup } from '@/lib/flows/expression-functions'

const GROUP_LABEL: Record<ExpressionFunctionGroup, string> = {
  text: 'Text',
  number: 'Numbers',
  logic: 'Logic',
  date: 'Dates',
  list: 'Lists',
}

const GROUP_ORDER: ExpressionFunctionGroup[] = ['text', 'number', 'date', 'list', 'logic']

/**
 * Reference for the `{{= ... }}` sublanguage, rendered straight from the registry
 * so a function can never ship without appearing here.
 */
export function FunctionReference() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const term = query.trim().toLowerCase()
    const specs = Object.values(EXPRESSION_FUNCTIONS).filter((spec) =>
      !term || spec.name.toLowerCase().includes(term) || spec.description.toLowerCase().includes(term))
    return GROUP_ORDER
      .map((group) => ({ group, specs: specs.filter((spec) => spec.group === group) }))
      .filter((entry) => entry.specs.length > 0)
  }, [query])

  return (
    <div className="border-t border-border px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-xs font-semibold text-muted-foreground hover:text-foreground"
      >
        {open ? 'Hide' : 'Show'} expression functions
      </button>
      {open && (
        <div className="mt-3 grid gap-3">
          <p className="text-xs text-muted-foreground">
            Use these inside <code className="rounded bg-muted px-1">{'{{= }}'}</code>, for example{' '}
            <code className="rounded bg-muted px-1">{'{{= upper(trigger.input) }}'}</code>.
          </p>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search functions"
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
          {groups.length === 0 && <p className="text-xs text-muted-foreground">No matching functions.</p>}
          {groups.map(({ group, specs }) => (
            <div key={group} className="grid gap-1">
              <p className="text-xs font-semibold text-foreground">{GROUP_LABEL[group]}</p>
              {specs.map((spec) => (
                <div key={spec.name} className="grid gap-0.5">
                  <code className="text-xs text-foreground">{spec.signature}</code>
                  <span className="text-xs text-muted-foreground">{spec.description}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
