'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, FileText, FolderOpen, Loader2, Lock, NotebookPen, Pencil, Search, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Markdown } from '@/components/ui/markdown'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'

/**
 * The workspace file repository: Markdown notes and uploaded documents every
 * agent can retrieve by similarity AND read by name (list_workspace_files /
 * read_workspace_file). Workspace-level like Traces — files are an org
 * resource with no goal dimension. What a viewer sees is the same rule the
 * API enforces: workspace-wide files, their own, and files attached to
 * agents they can read.
 */

type FileRow = {
  id: string
  title: string
  filename: string
  mimeType: string
  sizeBytes: number
  sourceType: string
  visibility: string
  agentId: string | null
  charCount: number
  passageCount: number
  canEdit: boolean
  updatedAt: string
}

type FileDetail = FileRow & { content: string }

type Visibility = 'organization' | 'private'

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.html,.htm,.log,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/*,application/json'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function isMarkdown(file: { filename: string; mimeType: string }): boolean {
  return /\.(md|markdown)$/i.test(file.filename) || /markdown/i.test(file.mimeType)
}

function kindLabel(file: FileRow): string {
  if (file.sourceType === 'manual') return 'Note'
  if (file.agentId) return 'Agent file'
  return 'Upload'
}

export default function KnowledgeFilesPage() {
  const [files, setFiles] = useState<FileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('organization')
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // The open document, with its body; `editing` swaps the viewer for a form.
  const [open, setOpen] = useState<FileDetail | null>(null)
  const [openLoading, setOpenLoading] = useState(false)
  // Identity of the latest read. A response is applied only if it is still
  // the newest request AND the dialog was not closed while it was in flight,
  // so a slow read can neither replace a later selection nor reopen the
  // dialog after the user dismissed it.
  const readSeq = useRef(0)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState<{ title: string; content: string }>({ title: '', content: '' })
  const [saving, setSaving] = useState(false)
  // New-note dialog.
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState<{ title: string; content: string }>({ title: '', content: '' })
  const [confirmDelete, setConfirmDelete] = useState<FileRow | null>(null)

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const response = await fetch('/api/knowledge?source=repository', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) throw new Error(data.error || 'Could not load workspace files.')
      setFiles(Array.isArray(data.documents) ? data.documents : [])
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load workspace files.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return files
    return files.filter((file) => file.title.toLowerCase().includes(needle) || file.filename.toLowerCase().includes(needle))
  }, [files, query])

  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(list)) {
        // One failed file (a rejected request included) must not stop the rest.
        try {
          const form = new FormData()
          form.append('file', file)
          form.append('visibility', visibility)
          const response = await fetch('/api/knowledge', { method: 'POST', body: form })
          const data = await response.json().catch(() => ({}))
          if (response.ok && data.document) toast.success(`Added "${data.document.filename}" (${data.document.chunkCount} passages).`)
          else toast.error(data.error || `Could not add "${file.name}".`)
        } catch {
          toast.error(`Could not add "${file.name}".`)
        }
      }
      await load()
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const saveNote = async () => {
    if (!note.title.trim() || !note.content.trim()) { toast.error('A note needs a title and some content.'); return }
    setSaving(true)
    try {
      const response = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: note.title.trim(), content: note.content, visibility }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not save the note.')
      toast.success(`Saved "${note.title.trim()}".`)
      setNoteOpen(false)
      setNote({ title: '', content: '' })
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the note.')
    } finally {
      setSaving(false)
    }
  }

  const openFile = async (file: FileRow) => {
    const seq = ++readSeq.current
    setOpenLoading(true)
    setEditing(false)
    try {
      const response = await fetch(`/api/knowledge/${encodeURIComponent(file.id)}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (seq !== readSeq.current) return
      if (!response.ok || !data.document) throw new Error(data.error || 'Could not open this file.')
      setOpen({ ...file, ...data.document })
      setEditDraft({ title: data.document.title, content: data.document.content })
    } catch (error) {
      if (seq !== readSeq.current) return
      toast.error(error instanceof Error ? error.message : 'Could not open this file.')
    } finally {
      if (seq === readSeq.current) setOpenLoading(false)
    }
  }

  const closeViewer = () => {
    // Invalidate any read still in flight so its response is dropped.
    readSeq.current += 1
    setOpenLoading(false)
    setOpen(null)
    setEditing(false)
  }

  const saveEdit = async () => {
    if (!open) return
    if (!editDraft.title.trim() || !editDraft.content.trim()) { toast.error('A file needs a title and some content.'); return }
    setSaving(true)
    try {
      const changes: Record<string, string> = {}
      if (editDraft.title.trim() !== open.title) changes.title = editDraft.title.trim()
      if (editDraft.content !== open.content) changes.content = editDraft.content
      if (!Object.keys(changes).length) { setEditing(false); return }
      const response = await fetch(`/api/knowledge/${encodeURIComponent(open.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not save your changes.')
      toast.success('Saved.')
      setOpen({ ...open, title: editDraft.title.trim(), content: editDraft.content })
      setEditing(false)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save your changes.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!confirmDelete) return
    const target = confirmDelete
    setConfirmDelete(null)
    const previous = files
    setFiles((prev) => prev.filter((file) => file.id !== target.id))
    if (open?.id === target.id) setOpen(null)
    try {
      const response = await fetch('/api/knowledge', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: target.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Could not remove "${target.title}".`)
      toast.success(`Removed "${target.title}".`)
    } catch (error) {
      setFiles(previous)
      toast.error(error instanceof Error ? error.message : `Could not remove "${target.title}".`)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <PageHeader
        icon={FolderOpen}
        eyebrow="Workspace"
        title="Files"
        description="Reference material your agents can draw on: Markdown notes, playbooks, specs, and uploaded documents. Every agent can read these by name in a run, and the most relevant passages reach its prompt automatically."
        actions={
          <>
            <Select value={visibility} onValueChange={(next) => setVisibility(next as Visibility)}>
              <SelectTrigger className="h-9 w-40" aria-label="Who can use new files"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="organization">Whole workspace</SelectItem>
                <SelectItem value="private">Only my agents</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => { setNote({ title: '', content: '' }); setNoteOpen(true) }}>
              <NotebookPen className="mr-1.5 h-4 w-4" />New note
            </Button>
            <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
              Upload files
            </Button>
            <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(event) => upload(event.target.files)} />
          </>
        }
      />

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" aria-label="Search files" className="pl-9" />
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((row) => <Skeleton key={row} className="h-14 rounded-lg" />)}
        </div>
      ) : loadError ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {loadError} <button type="button" className="font-medium underline" onClick={() => { setLoading(true); void load() }}>Try again</button>
        </div>
      ) : files.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No files yet"
          description="Upload a playbook, paste a spec as a note, or drop in the documents your team keeps reaching for. Agents reference them by name in their runs."
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setNoteOpen(true)}><NotebookPen className="mr-1.5 h-4 w-4" />Write a note</Button>
              <Button onClick={() => inputRef.current?.click()}><Upload className="mr-1.5 h-4 w-4" />Upload files</Button>
            </div>
          }
        />
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No files match &ldquo;{query}&rdquo;.</p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card shadow-1">
          {visible.map((file) => (
            <li key={file.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <button type="button" onClick={() => openFile(file)} className="min-w-0 flex-1 text-left">
                <span className="block truncate font-medium text-foreground hover:underline">{file.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {file.filename} · {formatSize(file.sizeBytes)} · {file.passageCount} passages · {formatWhen(file.updatedAt)}
                </span>
              </button>
              <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
                <Badge variant="outline" className="text-[11px]">{kindLabel(file)}</Badge>
                {file.visibility === 'private' && (
                  <Badge variant="outline" className="gap-1 text-[11px]"><Lock className="h-3 w-3" aria-hidden="true" />Only me</Badge>
                )}
              </div>
              <a
                href={`/api/knowledge/${encodeURIComponent(file.id)}?download=1`}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-foreground"
                aria-label={`Download ${file.title}`}
                title="Download"
              >
                <Download className="h-4 w-4" />
              </a>
              {file.canEdit && (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(file)}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-red-600"
                  aria-label={`Remove ${file.title}`}
                  title="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        Only extracted text is kept — never the original binary. Stored encrypted; credential-shaped values are redacted on the way in.
        Files attached to a single agent are managed from that agent&apos;s settings. Retention settings live in{' '}
        <Link href="/settings?tab=workspace" className="underline underline-offset-2">Settings</Link>.
      </p>

      {/* Viewer / editor */}
      <Dialog open={Boolean(open) || openLoading} onOpenChange={(next) => { if (!next) closeViewer() }}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden">
          {openLoading || !open ? (
            <div className="space-y-3 py-6">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <>
              <DialogHeader>
                {editing ? (
                  <div>
                    <Label htmlFor="file-title">Title</Label>
                    <Input id="file-title" value={editDraft.title} maxLength={300} onChange={(event) => setEditDraft({ ...editDraft, title: event.target.value })} />
                  </div>
                ) : (
                  <DialogTitle className="flex flex-wrap items-center gap-2">
                    {open.title}
                    <Badge variant="outline" className="text-[11px]">{kindLabel(open)}</Badge>
                  </DialogTitle>
                )}
                <p className="text-xs text-muted-foreground">{open.filename} · {formatSize(open.sizeBytes)} · updated {formatWhen(open.updatedAt)}</p>
              </DialogHeader>
              <div className="max-h-[55vh] overflow-auto rounded-md border bg-background p-4">
                {editing ? (
                  <Textarea
                    aria-label="File content"
                    value={editDraft.content}
                    onChange={(event) => setEditDraft({ ...editDraft, content: event.target.value })}
                    className="min-h-[45vh] border-0 p-0 font-mono text-sm shadow-none focus-visible:ring-0"
                  />
                ) : isMarkdown(open) ? (
                  <Markdown className="prose prose-sm max-w-none dark:prose-invert">{open.content}</Markdown>
                ) : (
                  <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">{open.content}</pre>
                )}
              </div>
              <DialogFooter className="gap-2 sm:justify-between">
                <Button variant="ghost" asChild>
                  <a href={`/api/knowledge/${encodeURIComponent(open.id)}?download=1`}><Download className="mr-1.5 h-4 w-4" />Download</a>
                </Button>
                <div className="flex gap-2">
                  {editing ? (
                    <>
                      <Button variant="outline" onClick={() => { setEditing(false); setEditDraft({ title: open.title, content: open.content }) }} disabled={saving}>Cancel</Button>
                      <Button onClick={saveEdit} loading={saving}>Save</Button>
                    </>
                  ) : open.canEdit ? (
                    <Button variant="outline" onClick={() => setEditing(true)}><Pencil className="mr-1.5 h-4 w-4" />Edit</Button>
                  ) : null}
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* New note */}
      <Dialog open={noteOpen} onOpenChange={(next) => !next && setNoteOpen(false)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New note</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="note-title">Title</Label>
              <Input id="note-title" value={note.title} maxLength={300} onChange={(event) => setNote({ ...note, title: event.target.value })} placeholder="e.g. Customer onboarding playbook" />
            </div>
            <div>
              <Label htmlFor="note-content">Content (Markdown)</Label>
              <Textarea id="note-content" rows={14} value={note.content} onChange={(event) => setNote({ ...note, content: event.target.value })} placeholder="# Onboarding playbook&#10;&#10;1. Kick-off call within 2 days…" className="font-mono text-sm" />
            </div>
            <p className="text-xs text-muted-foreground">
              Saved as a Markdown file {visibility === 'private' ? 'only your agents' : 'every agent in the workspace'} can read. Change who can use it with the selector above.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={saveNote} loading={saving}>Save note</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={confirmDelete !== null} onOpenChange={(next) => !next && setConfirmDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove file</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Remove &ldquo;{confirmDelete?.title}&rdquo; from the workspace? Agents will no longer be able to read it. This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={remove}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
