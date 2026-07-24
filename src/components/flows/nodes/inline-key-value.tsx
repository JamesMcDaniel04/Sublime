'use client'

import { Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TokenTextEditor } from '../token-text-editor'
import { controlClass, labelClass, parseKeyValueRows, serializeKeyValueRows, tokenControlClass } from './field-primitives'
import type { KeyValueRow, TokenEditorWiring } from './types'

export function InlineKeyValue({
  label,
  editorKey,
  value,
  onChange,
  tokenWiring,
}: {
  label: string
  editorKey: string
  value?: string
  onChange: (value: string) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const rows = parseKeyValueRows(value)
  const updateRow = (index: number, patch: Partial<KeyValueRow>) => {
    onChange(serializeKeyValueRows(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row))))
  }
  const addRow = () => onChange(serializeKeyValueRows([...rows, { key: '', value: '' }]))
  const removeRow = (index: number) => onChange(serializeKeyValueRows(rows.filter((_, rowIndex) => rowIndex !== index)))

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <label className={labelClass}>{label}</label>
        <button type="button" onClick={addRow} className="text-xs font-semibold text-blue-700 hover:text-blue-900">
          Add row
        </button>
      </div>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={`${label}-${index}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_36px]">
            <input
              value={row.key}
              onChange={(event) => updateRow(index, { key: event.target.value })}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={controlClass}
              placeholder="Key"
            />
            <TokenTextEditor
              ref={registerEditor(`${editorKey}.${index}.value`)}
              value={row.value}
              labelCtx={labelCtx}
              onFocus={focusEditor(`${editorKey}.${index}.value`)}
              onChange={(next) => updateRow(index, { value: next })}
              className={cn(tokenControlClass, 'min-w-0')}
              placeholder="Value"
              ariaLabel={`${label} value`}
            />
            <button
              type="button"
              onClick={() => removeRow(index)}
              className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600"
              aria-label={`Remove ${label.toLowerCase()} row`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
