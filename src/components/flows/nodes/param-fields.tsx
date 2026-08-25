'use client'

import { visibleParams, type ParamSpec } from '@/lib/flows/node-params'
import { controlClass, labelClass } from './field-primitives'
import { cn } from '@/lib/utils'

/**
 * The generic renderer for declared node parameters.
 *
 * One component walks a `ParamSpec[]` and renders whatever `visibleParams`
 * says applies to the node's current values, so adding a field is a manifest
 * entry rather than another hand-written branch in a 200-line body. See
 * node-params.ts for why that matters — three fields shipped this session
 * that the executor read and no panel rendered.
 *
 * Scalar controls only. Composite editors (clause rows, name/value rows) stay
 * bespoke; the manifest is not trying to become a form framework.
 */
export function ParamFields({
  specs,
  data,
  nodeId,
  onPatch,
  onFocusText,
  onBlurText,
}: {
  specs: ParamSpec[]
  data: Record<string, unknown>
  /** Namespaces control ids so two nodes on screen cannot collide. */
  nodeId: string
  /** Called with just the changed keys, for the caller to merge onto the node. */
  onPatch: (patch: Record<string, unknown>) => void
  /** Token editors elsewhere in the pane need to know a plain input has focus. */
  onFocusText?: () => void
  onBlurText?: () => void
}) {
  const shown = visibleParams(specs, data)
  if (shown.length === 0) return null

  return (
    <>
      {shown.map((spec) => {
        const id = `${nodeId}-${spec.key}`
        const value = data[spec.key]

        // Cleared inputs write undefined, not ''. Every one of these fields is
        // optional in the schema, and an empty string is a VALUE the executor
        // would honour — the difference between "no separator" and "join with
        // nothing".
        const patchText = (next: string) => onPatch({ [spec.key]: next === '' ? undefined : next })

        const patchNumber = (next: string) => {
          const parsed = Number(next)
          if (next === '' || !Number.isFinite(parsed)) return onPatch({ [spec.key]: undefined })
          // The spec's bounds mirror the executor's own clamp. Writing a value
          // outside them would let the run silently rewrite what the builder
          // showed, so an out-of-range entry writes nothing instead.
          const min = spec.min ?? Number.NEGATIVE_INFINITY
          const max = spec.max ?? Number.POSITIVE_INFINITY
          if (parsed < min) return onPatch({ [spec.key]: undefined })
          onPatch({ [spec.key]: Math.min(max, Math.floor(parsed)) })
        }

        return (
          <div key={`${spec.key}:${spec.label}`} className="grid gap-2">
            <label className={labelClass} htmlFor={id}>
              {spec.label}
              {spec.required && <span className="text-red-500"> *</span>}
            </label>

            {spec.control === 'select' ? (
              <select
                id={id}
                aria-label={spec.label}
                className={controlClass}
                value={String(value ?? spec.options?.[0]?.value ?? '')}
                onChange={(event) => onPatch({ [spec.key]: event.target.value })}
              >
                {(spec.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : spec.control === 'textarea' ? (
              <textarea
                id={id}
                aria-label={spec.label}
                rows={4}
                className={cn(controlClass, 'h-auto resize-y py-2 font-mono text-xs')}
                placeholder={spec.placeholder}
                value={String(value ?? '')}
                onFocus={onFocusText}
                onBlur={onBlurText}
                onChange={(event) => patchText(event.target.value)}
              />
            ) : (
              <input
                id={id}
                aria-label={spec.label}
                type={spec.control === 'number' ? 'number' : 'text'}
                {...(spec.control === 'number' ? { min: spec.min, max: spec.max } : {})}
                className={controlClass}
                placeholder={spec.placeholder}
                value={String(value ?? '')}
                onFocus={onFocusText}
                onBlur={onBlurText}
                onChange={(event) =>
                  spec.control === 'number' ? patchNumber(event.target.value) : patchText(event.target.value)
                }
              />
            )}

            {spec.help && <p className="text-xs text-muted-foreground">{spec.help}</p>}
          </div>
        )
      })}
    </>
  )
}
