'use client'

import { useEffect, useState } from 'react'
import { Check, Code2, Copy, Download, Eye, Maximize2, Minimize2, Monitor, Smartphone, Tablet } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Tag names whose presence signals a genuine HTML document/fragment rather
 * than prose with an occasional inline tag (e.g. a lone `<br>`). Kept
 * conservative on purpose: markdown output must never trip this.
 */
const STRUCTURAL_TAGS = ['!doctype', 'html', 'table', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'section', 'main', 'body']
const LEADING_TAG_PATTERN = new RegExp(`<(${STRUCTURAL_TAGS.join('|')})\\b`, 'i')
// `!doctype` has no closing tag, so the paired-tag fallback below excludes it.
const PAIRABLE_TAGS = STRUCTURAL_TAGS.filter((tag) => tag !== '!doctype')

/**
 * True when `value` looks like an HTML document or fragment (as opposed to
 * markdown or prose that merely contains a stray tag like `<br>`).
 *
 * Two ways in:
 *  1. The trimmed content starts with `<` and that leading tag is one of the
 *     structural tags above (`<!doctype`, `<html>`, `<div>`, `<table>`, …).
 *  2. The content isn't tag-first, but it contains a matched opening AND
 *     closing pair for the same structural tag (HTML embedded mid-text).
 *     A single unmatched tag (e.g. "Use <br> to break lines") never matches.
 */
export function looksLikeHtml(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('<') && LEADING_TAG_PATTERN.test(trimmed)) return true
  return PAIRABLE_TAGS.some((tag) => {
    const openPattern = new RegExp(`<${tag}\\b`, 'i')
    const closePattern = new RegExp(`</${tag}\\s*>`, 'i')
    return openPattern.test(trimmed) && closePattern.test(trimmed)
  })
}

/** Wraps a raw HTML fragment in a minimal document skeleton so it renders
 *  with sane defaults (font, color, wrapping) inside the sandboxed iframe.
 *  Skipped when the content already declares its own `<html>` root. */
function toDocument(html: string): string {
  if (/<html[\s>]/i.test(html)) return html
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    *{box-sizing:border-box}body{margin:0;padding:20px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#172033;font-size:14px;line-height:1.55;word-break:break-word;background:#f7f9fc}h1,h2,p{margin-top:0}.artifact{--accent:#4f46e5;--soft:#eef2ff;max-width:920px;margin:auto}.theme-sales{--accent:#0f766e;--soft:#ecfdf5}.theme-engineering{--accent:#4f46e5;--soft:#eef2ff}.theme-marketing{--accent:#c2410c;--soft:#fff7ed}.theme-finance{--accent:#047857;--soft:#ecfdf5}.theme-csm{--accent:#7c3aed;--soft:#f5f3ff}.hero{position:relative;display:grid;grid-template-columns:auto 1fr auto;gap:16px;align-items:start;padding:24px;border:1px solid #e3e8f0;border-radius:18px;background:linear-gradient(135deg,#fff 20%,var(--soft));box-shadow:0 8px 24px rgba(15,23,42,.06)}.hero-icon{display:grid;place-items:center;width:52px;height:52px;border-radius:15px;background:#fff;font-size:27px;box-shadow:0 4px 12px rgba(15,23,42,.09)}h1{margin-bottom:7px;font-size:25px;line-height:1.18;letter-spacing:-.025em}.subtitle{max-width:650px;margin:0;color:#596579}.eyebrow{margin-bottom:5px;color:var(--accent);font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.status,.count{display:inline-flex;align-items:center;white-space:nowrap;border:1px solid color-mix(in srgb,var(--accent) 22%,white);border-radius:999px;padding:5px 9px;background:#fff;color:var(--accent);font-size:11px;font-weight:750}.metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}.metric{display:grid;grid-template-columns:auto 1fr;gap:0 9px;align-items:center;padding:14px;border:1px solid #e3e8f0;border-radius:14px;background:#fff;box-shadow:0 3px 10px rgba(15,23,42,.035)}.metric>span{grid-row:1/3;font-size:21px}.metric strong{font-size:17px;line-height:1.2}.metric small{color:#748095;font-size:10px}.panel{margin-top:12px;padding:20px;border:1px solid #e3e8f0;border-radius:16px;background:#fff;box-shadow:0 4px 14px rgba(15,23,42,.04)}.panel h2{margin-bottom:13px;font-size:16px}.summary{border-left:4px solid var(--accent);background:linear-gradient(90deg,var(--soft),#fff 60%)}.summary p{margin:0;font-size:14px;line-height:1.7}.section-heading{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px}.section-heading h2,.section-heading p{margin-bottom:0}.table-wrap{overflow:auto;border:1px solid #e7ebf2;border-radius:11px}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:11px 12px;border-bottom:1px solid #edf0f5;text-align:left;vertical-align:top}thead th{background:#f8fafc;color:#657188;font-size:10px;letter-spacing:.06em;text-transform:uppercase}tbody th{color:var(--accent);font-size:11px;white-space:nowrap}tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}.source-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.source{padding:13px;border:1px solid #e7ebf2;border-radius:12px;background:#fbfcfe}.source strong{color:var(--accent)}.source p{margin:4px 0;color:#4d596d;font-size:12px}.source small{color:#8490a3;font-size:10px}footer{margin:14px 0 4px;padding:13px 16px;border-radius:12px;background:#172033;color:#fff;text-align:center;font-size:12px;font-weight:650}@media(max-width:700px){body{padding:12px}.hero{grid-template-columns:auto 1fr}.status{grid-column:1/-1}.metric-grid{grid-template-columns:repeat(2,1fr)}.source-grid{grid-template-columns:1fr}.panel{padding:14px}}
  </style></head><body>${html}</body></html>`
}

/**
 * Renders agent-produced HTML (e.g. an email-brief body) as actual formatted
 * markup instead of raw text — without pulling in a sanitizer dependency.
 *
 * Safety: the iframe uses `sandbox=""` with NEITHER `allow-scripts` NOR
 * `allow-same-origin`. That combination makes the iframe's origin opaque and
 * scripts inert, so any `<script>`, inline event handler, or `javascript:`
 * link in the agent's HTML simply does not execute, and the frame can't read
 * or write cookies/localStorage. This is what makes rendering untrusted
 * agent HTML directly safe.
 *
 * A side effect of that same origin lockdown: the parent document is denied
 * access to `iframe.contentDocument` (cross-origin per the spec), so we
 * cannot measure `contentDocument.body.scrollHeight` on load to auto-size
 * the frame the way you normally would. Instead we use a fixed collapsed
 * height with internal scrolling, plus an explicit Expand/Collapse toggle.
 */
type Viewport = 'desktop' | 'tablet' | 'mobile'

const VIEWPORT_WIDTH: Record<Viewport, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '390px',
}

export function HtmlPreview({ html, className }: { html: string; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const [viewport, setViewport] = useState<Viewport>('desktop')
  const [fullscreen, setFullscreen] = useState(false)
  const height = fullscreen ? 'calc(100vh - 92px)' : expanded ? 1400 : 620

  useEffect(() => {
    if (!fullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [fullscreen])

  const copyHtml = async () => {
    try {
      await navigator.clipboard.writeText(html)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const saveHtml = () => {
    const blob = new Blob([toDocument(html)], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'agent-artifact.html'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const viewportButton = (value: Viewport, label: string, Icon: typeof Monitor) => (
    <button
      type="button"
      onClick={() => setViewport(value)}
      className={cn('rounded p-1 transition-colors hover:bg-muted', viewport === value ? 'bg-muted text-foreground' : 'text-muted-foreground')}
      aria-label={`${label} preview`}
      title={`${label} preview`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )

  return (
    <div className={cn('min-h-[120px] w-full', fullscreen && 'fixed inset-0 z-[100] overflow-auto bg-background p-4', className)}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <span className="mono-label text-muted-foreground">Rendered output</span>
          {!showRaw && (
            <span className="flex items-center rounded border bg-background p-0.5">
              {viewportButton('desktop', 'Desktop', Monitor)}
              {viewportButton('tablet', 'Tablet', Tablet)}
              {viewportButton('mobile', 'Mobile', Smartphone)}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyHtml}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Copy the HTML source"
          >
            {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy HTML'}
          </button>
          <button
            type="button"
            onClick={saveHtml}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Save as a standalone HTML file"
          >
            <Download className="h-3 w-3" /> Export
          </button>
          <button
            type="button"
            onClick={() => setShowRaw((value) => !value)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {showRaw ? <Eye className="h-3 w-3" /> : <Code2 className="h-3 w-3" />}
            {showRaw ? 'Rendered' : 'Raw'}
          </button>
          {!showRaw && (
            <button
              type="button"
              onClick={() => setFullscreen((value) => !value)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={fullscreen ? 'Exit full screen' : 'Open full screen'}
            >
              {fullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
              {fullscreen ? 'Exit' : 'Full screen'}
            </button>
          )}
        </span>
      </div>

      {showRaw ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
          {html}
        </pre>
      ) : (
        <>
          <div className="overflow-auto rounded-lg bg-slate-100 p-2">
            <iframe
              title="Agent HTML output"
              srcDoc={toDocument(html)}
              sandbox=""
              scrolling={expanded || fullscreen ? 'yes' : 'no'}
              className={cn('mx-auto block max-w-full rounded-lg border border-border bg-white shadow-sm', !expanded && !fullscreen && 'overflow-hidden')}
              style={{ height, width: VIEWPORT_WIDTH[viewport] }}
            />
          </div>
          {!fullscreen && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="mt-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
