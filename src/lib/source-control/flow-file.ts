import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import { sanitizeNode, sanitizeTrigger } from '@/lib/export/portable'

/**
 * A flow, as a file that belongs in a git repository.
 *
 * **The property everything here serves:** pushing an UNCHANGED flow must
 * produce byte-identical content. A diff that appears on every push is a diff
 * nobody reads, which defeats the point of putting flows under review.
 *
 * That rules out reusing the export path directly — `toPortableFlow` stamps an
 * `exportedAt` timestamp, which alone would guarantee a spurious change every
 * time. It also rules out plain `JSON.stringify`, whose output depends on the
 * order keys happened to be inserted: the same flow loaded through two
 * different queries could serialize differently and produce a phantom diff.
 *
 * Redaction is delegated to the export sanitizers rather than reimplemented. A
 * repository is the easiest place in the system to leak a credential, and
 * unlike a database row it is copied into every clone, forever.
 */

interface SourceControlFlow {
  id: string
  name: string
  description?: string | null
  trigger?: unknown
  graph: unknown
}

/**
 * JSON with every object's keys in a fixed order.
 *
 * Arrays are left ALONE: their order is data. Sorting a graph's `nodes` would
 * silently change what the graph means.
 *
 * Two-space indentation because a person reviews this in a pull request.
 */
export function canonicalJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonical((input as Record<string, unknown>)[key])]),
      )
    }
    return input
  }
  return JSON.stringify(canonical(value), null, 2)
}

/**
 * Keys whose VALUE is treated as a credential and dropped from the trigger.
 *
 * Defense in depth: no trigger type stores any of these today (the real ones,
 * webhookSecretHash and webhookSecretEnc, are handled by sanitizeTrigger). But
 * a repository is the worst place in the system to leak a credential — every
 * clone, forever, and no way to unpublish it — so a trigger field added later
 * must not be able to ship on the next push simply because nobody thought
 * about this file.
 */
/**
 * Matched as a SUBSTRING, not an exact name. An enumeration of exact keys is a
 * losing game — the first draft of this listed `apiKey` and missed `apiToken`.
 *
 * The trade is deliberate and one-directional: a false positive strips a
 * non-secret trigger field from a file, which someone notices and reports. A
 * false negative writes a live credential into a git history, which nobody
 * notices and which cannot be taken back. Only the trigger passes through
 * here — graph nodes use the export sanitizers — so the blast radius of an
 * over-eager match is small.
 */
const CREDENTIAL_KEY = /secret|password|passphrase|token|credential|privatekey|private_key/i

function stripCredentialKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCredentialKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !CREDENTIAL_KEY.test(key))
        .map(([key, inner]) => [key, stripCredentialKeys(inner)]),
    )
  }
  return value
}

/** The document that is written to the repository. */
function flowDocument(flow: SourceControlFlow) {
  const graph = (flow.graph && typeof flow.graph === 'object' ? flow.graph : { nodes: [], edges: [] }) as FlowGraph
  return {
    // A version on the FILE FORMAT, so a future change to this shape can be
    // detected on pull rather than misread.
    formatVersion: 1,
    // Identity lives in the file, not the filename — see flowFilePath.
    id: flow.id,
    name: flow.name,
    description: flow.description ?? '',
    trigger: stripCredentialKeys(sanitizeTrigger(flow.trigger)),
    graph: {
      nodes: (graph.nodes ?? []).map((node) => sanitizeNode(node as FlowNode)),
      edges: graph.edges ?? [],
    },
  }
}

/**
 * The file's content.
 *
 * Ends with a newline: it is a text file, and a missing trailing newline makes
 * every diff tool report a change on the last line.
 */
export function flowFileContent(flow: SourceControlFlow): string {
  return `${canonicalJson(flowDocument(flow))}\n`
}

/** Anything that would be awkward or unsafe in a path. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Where the file lives.
 *
 * Readable AND unique: a repository full of `flows/clx123abc.json` is
 * technically fine and miserable to browse, so the name leads and the id
 * disambiguates.
 *
 * Renaming a flow therefore changes its path. That is deliberate and safe,
 * because a pull identifies a flow by the id INSIDE the file — git records the
 * change as a rename, and nothing depends on the filename being stable.
 */
export function flowFilePath(flow: { id: string; name: string }): string {
  const slug = slugify(flow.name ?? '')
  return slug ? `flows/${slug}--${flow.id}.json` : `flows/${flow.id}.json`
}

/**
 * The flow a file describes, or null if it is not one of ours.
 *
 * Read from the content rather than the path, so a rename in the repository —
 * or a file someone moved by hand — still resolves to the right flow.
 */
export function flowIdFromFile(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { id?: unknown; formatVersion?: unknown }
    if (typeof parsed?.id !== 'string' || !parsed.id) return null
    if (typeof parsed.formatVersion !== 'number') return null
    return parsed.id
  } catch {
    return null
  }
}
