'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SOURCE_LABELS } from './source-labels'
import { slotLabel } from './slot-labels'
import { SourceLogo } from './source-logo'
import {
  sourceIsAvailable,
  type MetricSourceOption,
} from '@/lib/metrics/source-options'
import { NO_CONNECTION_SOURCES } from '@/lib/goals/metric-sources'

export type MetricBinding = {
  label: string
  role: 'primary' | 'supporting' | 'component'
  /** Which composition slot this binding fills. Set only for role
   *  'component' — the create route rejects a slot on any other role. */
  slot?: string
  source: string
  metricKey: string
  unit: 'usd' | 'count' | 'percent'
  connectionRef: string | null
  config: Record<string, unknown>
}


/** Why this binding would fail the create route, or null when it is ready.
 * Mirrors the server's per-source zod checks so the Copilot preview can gate
 * Create with a specific hint instead of a raw 400 toast. */
export function metricBindingIssue(binding: MetricBinding): string | null {
  const text = (key: string) =>
    typeof binding.config[key] === 'string' ? (binding.config[key] as string).trim() : ''
  // A component names its slot, not its role — "Name the component series"
  // tells the user nothing about which driver is unnamed.
  const noun =
    binding.role === 'component' && binding.slot
      ? `"${slotLabel(binding.slot)}" driver`
      : `${binding.role} series`
  if (!binding.label.trim()) return `Name the ${noun}.`
  if (!NO_CONNECTION_SOURCES.has(binding.source) && !binding.connectionRef) {
    return `Pick the account "${binding.label}" reads from.`
  }
  const required: Record<string, Array<[key: string, hint: string]>> = {
    google_sheets: [
      ['spreadsheetId', 'Enter the spreadsheet id for'],
      ['range', 'Enter the A1 range for'],
    ],
    google_analytics: [['propertyId', 'Pick the GA4 property for']],
    postgres: [['query', 'Enter the SQL query for']],
    url: [['url', 'Enter the URL that reports']],
    slack_assisted: [['channel', 'Enter the Slack channel that reports']],
    gmail_assisted: [['query', 'Enter the Gmail search that finds']],
  }
  for (const [key, hint] of required[binding.source] ?? []) {
    if (!text(key)) return `${hint} "${binding.label}".`
  }
  return null
}

export function MetricBindingFields({
  binding,
  sources,
  onChange,
}: {
  binding: MetricBinding
  sources: MetricSourceOption[]
  onChange: (next: MetricBinding) => void
}) {
  const option = sources.find(
    (candidate) => candidate.source === binding.source,
  )
  const setConfig = (key: string, value: string) =>
    onChange({
      ...binding,
      config: { ...binding.config, [key]: value },
    })
  const text = (key: string) =>
    typeof binding.config[key] === 'string'
      ? (binding.config[key] as string)
      : ''
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="font-medium">Source</span>
          <Select
            value={binding.source}
            onValueChange={(source) => {
              const next = sources.find(
                (candidate) => candidate.source === source,
              )
              onChange({
                ...binding,
                source,
                metricKey:
                  next?.metrics[0]?.key ??
                  (source === 'manual' ? 'manual.value' : ''),
                connectionRef:
                  next && next.connections.length === 1
                    ? next.connections[0].ref
                    : null,
                config: {},
              })
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sources.filter(sourceIsAvailable).map((candidate) => (
                <SelectItem
                  key={candidate.source}
                  value={candidate.source}
                >
                  <span className="flex items-center gap-2">
                    <SourceLogo source={candidate.source} className="h-4 w-4" />
                    {SOURCE_LABELS[candidate.source] ?? candidate.source}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {option && option.connections.length > 1 && (
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Account</span>
            <Select
              value={binding.connectionRef ?? ''}
              onValueChange={(connectionRef) =>
                onChange({ ...binding, connectionRef })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose account" />
              </SelectTrigger>
              <SelectContent>
                {option.connections.map((connection) => (
                  <SelectItem
                    key={connection.ref}
                    value={connection.ref}
                  >
                    {connection.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
        {option && option.metrics.length > 1 && (
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Metric</span>
            <Select
              value={binding.metricKey}
              onValueChange={(metricKey) =>
                onChange({ ...binding, metricKey })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {option.metrics.map((metric) => (
                  <SelectItem key={metric.key} value={metric.key}>
                    {metric.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
      </div>
      {binding.source === 'google_sheets' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            value={text('spreadsheetId')}
            onChange={(event) =>
              setConfig('spreadsheetId', event.target.value)
            }
            placeholder="Spreadsheet id (1AbC…)"
            aria-label="Spreadsheet id"
          />
          <Input
            value={text('range')}
            onChange={(event) => setConfig('range', event.target.value)}
            placeholder="A1 range (KPIs!B2)"
            aria-label="A1 range"
          />
        </div>
      )}
      {binding.source === 'google_analytics' && (
        <Ga4PropertyField
          connectionRef={binding.connectionRef}
          value={text('propertyId')}
          onChange={(propertyId) => setConfig('propertyId', propertyId)}
        />
      )}
      {binding.source === 'postgres' && (
        <Textarea
          value={text('query')}
          onChange={(event) => setConfig('query', event.target.value)}
          className="min-h-24 font-mono text-sm"
          placeholder="SELECT count(*) FROM completed_orders"
          aria-label="Read-only SQL query"
          maxLength={10_000}
        />
      )}
      {binding.source === 'url' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            value={text('url')}
            onChange={(event) => setConfig('url', event.target.value)}
            placeholder="https://status.example.com/mrr.json"
            aria-label="URL"
          />
          <Input
            value={text('jsonPath')}
            onChange={(event) =>
              setConfig('jsonPath', event.target.value)
            }
            placeholder="JSON path (optional)"
            aria-label="JSON path"
          />
        </div>
      )}
      {binding.source === 'slack_assisted' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            value={text('channel')}
            onChange={(event) => setConfig('channel', event.target.value)}
            placeholder="#revenue"
            aria-label="Slack channel"
          />
          <Input
            value={text('metricHint')}
            onChange={(event) =>
              setConfig('metricHint', event.target.value)
            }
            placeholder="What number should we read? (optional)"
            aria-label="Metric hint"
          />
        </div>
      )}
      {binding.source === 'gmail_assisted' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            value={text('query')}
            onChange={(event) => setConfig('query', event.target.value)}
            placeholder="subject:(weekly revenue report)"
            aria-label="Gmail search"
          />
          <Input
            value={text('metricHint')}
            onChange={(event) =>
              setConfig('metricHint', event.target.value)
            }
            placeholder="What number should we read? (optional)"
            aria-label="Metric hint"
          />
        </div>
      )}
    </div>
  )
}

/** GA4 property chooser. A numeric property id is not something anyone can
 *  recite, so offer names — but degrade to a raw input when discovery returns
 *  nothing, rather than blocking goal creation on a failed probe. */
function Ga4PropertyField({
  connectionRef,
  value,
  onChange,
}: {
  readonly connectionRef: string | null
  readonly value: string
  readonly onChange: (propertyId: string) => void
}) {
  const [properties, setProperties] = useState<Array<{ propertyId: string; displayName: string }>>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!connectionRef) return
    let cancelled = false
    setLoaded(false)
    fetch(`/api/goals/metrics/ga4/properties?connectionRef=${encodeURIComponent(connectionRef)}`)
      .then((response) => response.json())
      .then((body: { properties?: Array<{ propertyId: string; displayName: string }> }) => {
        if (!cancelled) setProperties(body.properties ?? [])
      })
      .catch(() => {
        if (!cancelled) setProperties([])
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [connectionRef])

  if (loaded && properties.length === 0) {
    return (
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="GA4 property id (493820104)"
        aria-label="GA4 property id"
      />
    )
  }

  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger aria-label="GA4 property">
        <SelectValue placeholder={loaded ? 'Choose a property' : 'Loading properties…'} />
      </SelectTrigger>
      <SelectContent>
        {properties.map((property) => (
          <SelectItem key={property.propertyId} value={property.propertyId}>
            {property.displayName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
