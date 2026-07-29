'use client'

import { ScopedLink as Link } from '@/components/ui/scoped-link'
import { useEffect, useState } from 'react'
import { AlertTriangle, Plus, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { fmtValue } from '@/components/goals/chart-math'
import { resolveMetric, type WidgetProps } from './goal-dashboard'

export function HistoryWidget({ config, data }: WidgetProps) {
  const metric = resolveMetric(data, config.metricId)
  const [recordOpen, setRecordOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importCsv, setImportCsv] = useState('')
  const [importing, setImporting] = useState(false)
  const [record, setRecord] = useState({ value: '', capturedAt: '' })

  useEffect(() => {
    if (
      !data.preview &&
      metric?.role === 'primary' &&
      new URLSearchParams(window.location.search).get('import') === '1'
    ) {
      setImportOpen(true)
    }
  }, [data.preview, metric?.role])

  if (typeof config.metricId === 'string' && !metric) {
    return (
      <Card className="p-5 text-sm text-muted-foreground">
        This series was removed.
      </Card>
    )
  }

  const recordValue = async () => {
    const response = await fetch(`/api/goals/${data.goal.id}/datapoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        value: Number(record.value),
        ...(record.capturedAt
          ? {
              capturedAt: new Date(
                `${record.capturedAt}T12:00:00`,
              ).toISOString(),
            }
          : {}),
      }),
    })
    const body = await response.json()
    if (!response.ok) {
      toast.error(body.error || 'Could not record value.')
      return
    }
    await data.onReload()
    setRecordOpen(false)
    setRecord({ value: '', capturedAt: '' })
    toast.success('Value recorded and risk re-evaluated.')
  }

  const runImport = async () => {
    setImporting(true)
    try {
      const response = await fetch(
        `/api/goals/${data.goal.id}/datapoints/import`,
        {
          method: 'POST',
          headers: { 'content-type': 'text/csv' },
          body: importCsv,
        },
      )
      const body = await response.json()
      if (!response.ok) {
        toast.error(body.error || 'Import failed.')
        return
      }
      await data.onReload()
      setImportOpen(false)
      setImportCsv('')
      toast.success(
        body.skipped?.length
          ? `Imported ${body.imported} readings — ${body.skipped.length} line(s) skipped.`
          : `Imported ${body.imported} readings.`,
      )
    } finally {
      setImporting(false)
    }
  }

  const canMutate = !data.preview && metric?.role === 'primary'
  const datapoints = metric?.datapoints ?? []
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">
            {metric?.label ? `${metric.label} history` : 'Metric history'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {metric?.source ?? 'manual'} · {metric?.metricKey ?? 'value'}
          </p>
        </div>
        {canMutate && (
          <div className="flex items-center gap-2">
            <Dialog open={importOpen} onOpenChange={setImportOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                  <Upload className="mr-1.5 h-4 w-4" /> Import CSV
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Import historical readings</DialogTitle>
                </DialogHeader>
                <p className="text-sm text-muted-foreground">
                  Paste <code className="font-mono">date,value</code> rows
                  (header optional) or pick a .csv file — up to 1,000 rows,
                  one reading per day.
                </p>
                <Input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    const reader = new FileReader()
                    reader.onload = () =>
                      setImportCsv(String(reader.result ?? ''))
                    reader.readAsText(file)
                  }}
                />
                <Textarea
                  value={importCsv}
                  onChange={(event) => setImportCsv(event.target.value)}
                  placeholder={
                    'date,value\n2026-05-01,41200\n2026-06-01,44800'
                  }
                  className="min-h-36 font-mono text-xs"
                />
                <DialogFooter>
                  <Button
                    onClick={runImport}
                    disabled={importing || !importCsv.trim()}
                  >
                    {importing ? 'Importing…' : 'Import readings'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Dialog open={recordOpen} onOpenChange={setRecordOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="mr-1.5 h-4 w-4" /> Record value
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Record a metric value</DialogTitle>
                </DialogHeader>
                <label className="space-y-1.5 text-sm">
                  <span>Value</span>
                  <Input
                    type="number"
                    step="any"
                    value={record.value}
                    onChange={(event) =>
                      setRecord({ ...record, value: event.target.value })
                    }
                  />
                </label>
                <label className="space-y-1.5 text-sm">
                  <span>Date (optional)</span>
                  <Input
                    type="date"
                    value={record.capturedAt}
                    onChange={(event) =>
                      setRecord({
                        ...record,
                        capturedAt: event.target.value,
                      })
                    }
                  />
                </label>
                <DialogFooter>
                  <Button
                    onClick={recordValue}
                    disabled={
                      !Number.isFinite(Number(record.value)) ||
                      record.value === ''
                    }
                  >
                    Record value
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>
      {metric?.lastError && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Metric source needs attention</p>
            <p>{metric.lastError}</p>
            <Button
              variant="link"
              className="h-auto p-0 text-warning"
              asChild
            >
              <Link href="/integrations">Reconnect source</Link>
            </Button>
          </div>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Value</TableHead>
            <TableHead>Origin</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {datapoints.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={3}
                className="text-sm text-muted-foreground"
              >
                No readings yet — record one or wait for the next sync.
              </TableCell>
            </TableRow>
          ) : (
            [...datapoints].reverse().map((point) => (
              <TableRow key={point.id}>
                <TableCell>
                  {new Date(point.capturedAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="font-mono">
                  {fmtValue(point.value, metric?.unit ?? data.goal.unit)}
                </TableCell>
                <TableCell>
                  {point.origin === 'assisted' ? (
                    <Badge variant="secondary">AI-read</Badge>
                  ) : (
                    <Badge variant="outline">{point.origin}</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Card>
  )
}
