'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Upload, FileText, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

type KnowledgeDoc = {
  id: string
  filename: string
  sizeBytes: number
  charCount: number
  chunkCount: number
  status: string
  createdAt: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Upload + manage the files an agent uses as knowledge (RAG at run time). */
export function KnowledgePanel({ agentId }: { agentId: string }) {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')
    fetch(`/api/agents/${agentId}/knowledge`, { cache: 'no-store' })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}))
        if (!r.ok || !data.success) throw new Error(data.error || 'Could not load knowledge files.')
        return data
      })
      .then((data) => {
        if (!cancelled) setDocs(data.documents ?? [])
      })
      .catch((cause) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : 'Could not load knowledge files.') })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId, loadAttempt])

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.append('file', file)
        const response = await fetch(`/api/agents/${agentId}/knowledge`, { method: 'POST', body: form })
        const data = await response.json().catch(() => ({}))
        if (response.ok && data.document) {
          setDocs((prev) => [data.document, ...prev])
          toast.success(`Added "${data.document.filename}" (${data.document.chunkCount} passages).`)
        } else {
          toast.error(data.error || `Could not add "${file.name}".`)
        }
      }
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const remove = async (doc: KnowledgeDoc) => {
    const previous = docs
    setDocs((prev) => prev.filter((d) => d.id !== doc.id))
    try {
      const response = await fetch(`/api/agents/${agentId}/knowledge`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: doc.id }),
      })
      if (!response.ok) throw new Error()
    } catch {
      setDocs(previous)
      toast.error(`Could not remove "${doc.filename}".`)
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="eyebrow">Knowledge</p>
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
          Upload files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.html,.htm,.log,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/*,application/json"
          className="hidden"
          onChange={(e) => upload(e.target.files)}
        />
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        Files only this agent can draw on at run time. PDF, DOCX, text, Markdown, CSV, JSON, HTML, and source files are supported.
        Files for every agent live in <Link href="/knowledge" className="underline underline-offset-2">Files</Link>.
      </p>
      {loading ? (
        <p className="text-sm text-muted-foreground">
          <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : loadError ? (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError} <button className="font-medium underline" onClick={() => setLoadAttempt((value) => value + 1)}>Try again</button></p>
      ) : docs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No files yet — upload documents to give this agent reference knowledge.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {docs.map((doc) => (
            <li key={doc.id} className="group flex items-center gap-3 px-3 py-2 text-sm">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={doc.filename}>
                {doc.filename}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatSize(doc.sizeBytes)} · {doc.chunkCount} passages
              </span>
              <button
                type="button"
                onClick={() => remove(doc)}
                className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                aria-label={`Remove ${doc.filename}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
