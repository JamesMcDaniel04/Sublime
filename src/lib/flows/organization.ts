/**
 * Flow icons and folders: the two fields that keep a workspace with fifty
 * flows navigable.
 *
 * Both are free-text columns defaulting to `''`, so the rules that keep them
 * meaningful live here rather than in a component — an input can be bypassed
 * by any other write path, and both fields are also set when a flow is
 * imported or duplicated.
 */

/**
 * Longest icon we accept, counted in GRAPHEME-ish units (code points), not
 * UTF-16 length. A family emoji is 7 code points and 11 `.length`, and a flag
 * is 2 code points and 4 `.length` — slicing by `.length` cuts them into
 * mojibake, which is why the cap below counts `[...value]`.
 */
const MAX_ICON_CODE_POINTS = 8

/** Longest folder name, so a pasted paragraph cannot become a heading. */
const MAX_FOLDER_LENGTH = 60

/** Control characters, including the newlines a paste brings along. */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/gu

/**
 * Normalize a flow's icon. Returns `''` for "use the default glyph", which is
 * both the column default and what we store for anything that is not
 * plausibly an icon.
 *
 * We deliberately do NOT try to validate "is an emoji" — that is a moving
 * target across Unicode versions, and rejecting a valid new emoji is a worse
 * failure than accepting an unusual character. Instead we bound the LENGTH,
 * which is the property that actually matters: a short glyph renders in a
 * 36px tile, a pasted sentence does not.
 *
 * Zero-width joiners are exempt from the control-character strip precisely
 * because they are what holds a multi-part emoji together.
 */
export function normalizeFlowIcon(raw: string): string {
  // U+200D (ZWJ) and U+FE0F (variation selector) are format characters that
  // are structural inside emoji, so preserve them and strip the rest.
  const cleaned = raw.replace(CONTROL_CHARS, (char) => (char === '‍' || char === '️' ? char : ''))
  const trimmed = cleaned.trim()
  if (!trimmed) return ''
  // Too long to be a glyph — treat as "no icon" rather than storing a
  // truncated fragment, which would render as meaningless partial text.
  return [...trimmed].length > MAX_ICON_CODE_POINTS ? '' : trimmed
}

/** Normalize a folder name. `''` means ungrouped. */
export function normalizeFlowFolder(raw: string): string {
  const collapsed = raw.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim()
  return collapsed.slice(0, MAX_FOLDER_LENGTH)
}

export interface FlowFolderGroup<T> {
  /** Display name, in the casing it was first seen. `''` is the ungrouped bucket. */
  folder: string
  flows: T[]
}

/**
 * Group flows by folder for the list view.
 *
 * Matching is case-INSENSITIVE. Folders are typed by hand, so "Sales" and
 * "sales" are a data-entry accident rather than two folders, and showing them
 * separately defeats the only thing folders are for. The first casing seen
 * wins for display, so the list reads the way the person who created the
 * folder wrote it.
 *
 * Ungrouped sorts LAST: it is the default state, so left at the top it would
 * push every deliberately-organized folder below the fold.
 */
export function groupFlowsByFolder<T extends { folder?: string | null }>(flows: T[]): FlowFolderGroup<T>[] {
  const groups = new Map<string, FlowFolderGroup<T>>()

  for (const flow of flows) {
    const display = normalizeFlowFolder(flow.folder ?? '')
    const key = display.toLowerCase()
    const existing = groups.get(key)
    if (existing) existing.flows.push(flow)
    else groups.set(key, { folder: display, flows: [flow] })
  }

  return [...groups.values()].sort((a, b) => {
    // Ungrouped last regardless of alphabet.
    if (a.folder === '') return 1
    if (b.folder === '') return -1
    return a.folder.localeCompare(b.folder, undefined, { sensitivity: 'base' })
  })
}
