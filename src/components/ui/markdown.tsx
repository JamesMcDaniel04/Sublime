'use client'

/**
 * Lazy facade over the markdown renderer. react-markdown + remark-gfm are a
 * ~144 kB chunk shared by every surface that renders assistant/agent output —
 * loading them on demand keeps that weight out of every page's first load
 * while call sites keep importing `Markdown` from here unchanged.
 *
 * While the renderer chunk loads, the raw text renders with preserved
 * whitespace — content is readable the instant it arrives and re-renders
 * formatted a beat later on first use.
 */
import { lazy, Suspense } from 'react'
import { cn } from '@/lib/utils'

const MarkdownImpl = lazy(() => import('./markdown-impl').then((m) => ({ default: m.Markdown })))

type MarkdownProps = { children: string; className?: string }

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <Suspense fallback={<div className={cn('whitespace-pre-wrap', className)}>{children}</div>}>
      <MarkdownImpl className={className}>{children}</MarkdownImpl>
    </Suspense>
  )
}
