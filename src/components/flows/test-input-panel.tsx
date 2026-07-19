'use client'

import type { TriggerInputField } from '@/lib/flows/graph'
import { fieldValuesFromFlowInput, flowInputFromFieldValues } from '@/lib/flows/test-input'

export const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
export const labelClass = 'mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground'

export function inputForField({
  field,
  value,
  onChange,
}: {
  field: TriggerInputField
  value: string
  onChange: (value: string) => void
}) {
  if (field.type === 'boolean') {
    return (
      <select className={fieldClass} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Not set</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }
  if (field.type === 'object' || field.type === 'array' || field.type === 'any') {
    return (
      <textarea
        rows={field.type === 'any' ? 2 : 4}
        className={`${fieldClass} min-h-[76px] resize-y font-mono text-xs`}
        value={value}
        placeholder={field.type === 'array' ? '["item one", "item two"]' : field.type === 'object' ? '{"account":"Acme"}' : 'Text, JSON, or a list'}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }
  return (
    <input
      type={field.type === 'number' ? 'number' : 'text'}
      className={fieldClass}
      value={value}
      placeholder={field.description || field.name}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function TestInputPanel({
  fields,
  value,
  onChange,
}: {
  fields: TriggerInputField[]
  value: string
  onChange: (value: string) => void
}) {
  const usableFields = fields.filter((field) => field.name.trim())
  const values = fieldValuesFromFlowInput(value, usableFields)
  if (!usableFields.length) return null

  const setField = (name: string, nextValue: string) => {
    onChange(flowInputFromFieldValues(usableFields, { ...values, [name]: nextValue }))
  }

  return (
    <div className="border-b border-border bg-card px-4 py-3 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Test input</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            These values are sent as the Run input when you click Run.
          </p>
        </div>
        <p className="rounded-full bg-indigo-50 px-2 py-1 text-[11px] font-medium text-indigo-700">
          {usableFields.length} expected field{usableFields.length === 1 ? '' : 's'}
        </p>
      </div>
      <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
        <div className="grid gap-3 md:grid-cols-2">
          {usableFields.map((field) => {
            const name = field.name.trim()
            return (
              <div key={name} className="rounded-lg border border-border/70 bg-muted/20 p-3">
                <label className={labelClass}>
                  <span className="font-mono">{name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground">{field.type}</span>
                  {field.required && <span className="text-red-500" title="Required">*</span>}
                </label>
                {field.description && <p className="mb-1.5 text-[11px] leading-4 text-muted-foreground">{field.description}</p>}
                {inputForField({ field, value: values[name] ?? '', onChange: (next) => setField(name, next) })}
              </div>
            )
          })}
        </div>
        <div>
          <label className={labelClass}>Raw payload</label>
          <textarea
            rows={8}
            className={`${fieldClass} min-h-[160px] resize-y font-mono text-xs`}
            value={value}
            placeholder='{"account":"Acme","priority":"high"}'
            onChange={(event) => onChange(event.target.value)}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">Advanced: edit the JSON sent to the flow directly.</p>
        </div>
      </div>
    </div>
  )
}
