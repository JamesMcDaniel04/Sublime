/**
 * Token preview for the builder: what a `{{token}}` field will actually
 * resolve to, using the REAL runtime resolver.
 *
 * Reusing `resolveTemplate` is the whole point — a preview with its own
 * token/expression semantics would drift from execution, and a wrong preview is
 * worse than none because the user believes it. `features/flows/context` is
 * pure (a single `import type`), so it is safe in a client component; do not
 * add runtime imports to it.
 *
 * Sample data comes from the last run, pinned outputs, or the test input —
 * never a live call. The UI labels it as a sample.
 */
import { resolveTemplate, type FlowContext } from '@/features/flows/context'

const DEFAULT_MAX_CHARS = 160
// Built per call, never shared: a /g/ regex carries `lastIndex`, and both
// `.test()` and `matchAll` read and advance it. Sharing one instance made the
// path scan start mid-string and silently miss tokens.
const tokenPattern = () => /\{\{\s*([^{}]+?)\s*\}\}/g
const HAS_TOKEN_RE = /\{\{\s*[^{}]+?\s*\}\}/

export type TokenPreview =
  | { kind: 'empty' }
  | { kind: 'literal' }
  | { kind: 'resolved'; text: string; truncated: boolean }
  | { kind: 'unresolved'; missing: string[] }

/** Builder-visible sample data → the context shape the runtime resolver reads. */
export function buildPreviewContext({
  lastOutputs,
  triggerInput,
  variables,
  inputs,
  item,
  loop,
}: {
  lastOutputs: Record<string, unknown>
  triggerInput?: unknown
  variables?: Record<string, unknown>
  inputs?: Record<string, unknown>
  item?: unknown
  loop?: { index: number; count: number }
}): FlowContext {
  return {
    trigger: { input: triggerInput },
    step: Object.fromEntries(Object.entries(lastOutputs).map(([id, output]) => [id, { output }])),
    ...(variables ? { variables } : {}),
    ...(inputs ? { input: inputs } : {}),
    ...(item !== undefined ? { item } : {}),
    ...(loop ? { loop } : {}),
  }
}

/**
 * Token paths in `template` that resolve to nothing against `ctx`.
 *
 * Needed because `resolveTemplate` renders a missing path as '' and cannot
 * report that it did — so a typo'd token would preview as a plausible blank.
 * Each path is probed on its own to tell "no data" from "data is empty".
 */
function unresolvedPaths(template: string, ctx: FlowContext): string[] {
  const missing: string[] = []
  for (const match of template.matchAll(tokenPattern())) {
    const path = match[1].trim()
    // Expressions carry their own fallbacks (coalesce, if, …) — a function
    // legitimately returning '' is not an unresolved reference. Inline
    // {{js: …}} runs server-side in QuickJS, so the client preview can't
    // evaluate it — it is not "unresolved", just deferred to runtime.
    if (path.startsWith('=') || path.startsWith('js:')) continue
    if (resolveTemplate(`{{${path}}}`, ctx) === '') missing.push(path)
  }
  return missing
}

export function previewToken(template: string, ctx: FlowContext, maxChars = DEFAULT_MAX_CHARS): TokenPreview {
  if (!template.trim()) return { kind: 'empty' }
  if (!HAS_TOKEN_RE.test(template)) return { kind: 'literal' }
  const missing = unresolvedPaths(template, ctx)
  if (missing.length > 0) return { kind: 'unresolved', missing }
  const full = resolveTemplate(template, ctx)
  return full.length > maxChars
    ? { kind: 'resolved', text: `${full.slice(0, maxChars - 1)}…`, truncated: true }
    : { kind: 'resolved', text: full, truncated: false }
}
