'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

/**
 * Renders a form-triggered flow's fields and submits them.
 *
 * Everything about the flow comes from the API, which returns only the title,
 * description and fields — never the graph. An anonymous caller learns what to
 * fill in and nothing about how the workspace works.
 *
 * The token is read from the query string on the client so it is never baked
 * into server-rendered HTML, where a proxy or browser cache could retain it.
 */

interface FormField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any'
  required: boolean
  description?: string
  defaultValue?: string
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; title: string; description: string; fields: FormField[] }
  | { status: 'submitted' }
  | { status: 'error'; message: string }

export function FormRunner({ flowId }: { flowId: string }) {
  const token = useSearchParams().get('token') ?? ''
  const [state, setState] = useState<State>({ status: 'loading' })
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    if (!token) {
      setState({ status: 'error', message: 'This link is missing its access token.' })
      return
    }
    try {
      const response = await fetch(`/api/flows/${encodeURIComponent(flowId)}/form?token=${encodeURIComponent(token)}`)
      const body = await response.json()
      if (!response.ok || !body.success) {
        // The API deliberately does not distinguish an unknown flow from a bad
        // token, and neither does this: telling someone which of their guesses
        // named a real flow is the thing the throttle exists to prevent.
        throw new Error('This form is not available. The link may have expired or been withdrawn.')
      }
      setState({ status: 'ready', title: body.title, description: body.description, fields: body.fields })
      setValues(Object.fromEntries(
        (body.fields as FormField[]).map((field) => [
          field.name,
          field.type === 'boolean' ? false : field.defaultValue ?? '',
        ]),
      ))
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : 'This form is not available.' })
    }
  }, [flowId, token])

  useEffect(() => { void load() }, [load])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      const response = await fetch(`/api/flows/${encodeURIComponent(flowId)}/form?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      })
      const body = await response.json()
      if (!response.ok || !body.success) {
        throw new Error(body.error || 'That could not be submitted.')
      }
      setState({ status: 'submitted' })
    } catch (error) {
      // Kept on the form rather than replacing it: a validation failure must
      // not discard everything the person typed.
      window.alert(error instanceof Error ? error.message : 'That could not be submitted.')
    } finally {
      setSubmitting(false)
    }
  }

  if (state.status === 'loading') {
    return <p className="text-center text-sm text-muted-foreground">Loading…</p>
  }

  if (state.status === 'error') {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground">{state.message}</p>
        </CardContent>
      </Card>
    )
  }

  if (state.status === 'submitted') {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <p className="text-base font-medium">Thanks — that&apos;s been submitted.</p>
          <p className="mt-1 text-sm text-muted-foreground">You can close this page.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{state.title}</CardTitle>
        {state.description && <p className="text-sm text-muted-foreground">{state.description}</p>}
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          {state.fields.map((field) => {
            const id = `field-${field.name}`
            return (
              <div key={field.name} className="grid gap-1.5">
                <label htmlFor={id} className="text-sm font-medium">
                  {field.name}
                  {field.required && <span className="ml-1 text-red-500" aria-hidden="true">*</span>}
                </label>
                {field.type === 'boolean' ? (
                  <input
                    id={id}
                    type="checkbox"
                    className="h-4 w-4"
                    checked={Boolean(values[field.name])}
                    onChange={(event) => setValues((previous) => ({ ...previous, [field.name]: event.target.checked }))}
                  />
                ) : (
                  <Input
                    id={id}
                    type={field.type === 'number' ? 'number' : 'text'}
                    required={field.required}
                    value={String(values[field.name] ?? '')}
                    onChange={(event) => setValues((previous) => ({ ...previous, [field.name]: event.target.value }))}
                    aria-describedby={field.description ? `${id}-help` : undefined}
                  />
                )}
                {field.description && (
                  <p id={`${id}-help`} className="text-xs text-muted-foreground">{field.description}</p>
                )}
              </div>
            )
          })}
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? 'Submitting…' : 'Submit'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
