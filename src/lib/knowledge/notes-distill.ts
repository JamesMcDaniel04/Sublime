/**
 * Meeting-note distillation — the "make sense of notes" leg. For each newly
 * ingested Granola note: one structured LLM pass over the AI SUMMARY (never
 * the transcript) extracts people, accounts, decisions, and commitments;
 * the result lands as
 *   1. an encrypted knowledge doc (`meeting_note`), private to the note's
 *      owner when their email matches a workspace user (org-visible
 *      otherwise — the org-level API key already exposes notes to agents);
 *   2. derived `made_commitment` activity events, which project into the
 *      graph through the normal indexActivity path and give the commitment
 *      miner (behavior/mine-commitments.ts) deterministic rows to work on.
 *
 * Budget discipline: at most MAX_DISTILL_PER_RUN LLM calls per invocation;
 * already-distilled notes (knowledge doc exists for the note id) are skipped
 * before any model call.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { ingestActivity } from '@/lib/activity/ingest'
import { meetingSeriesKey, GRANOLA_SOURCE, type GranolaNote } from '@/lib/activity/sources/granola'
import { storeKnowledge } from './store'

export const MAX_DISTILL_PER_RUN = 10
const SUMMARY_CHAR_CAP = 6_000

export type NoteDistillation = {
  people: string[]
  accounts: string[]
  decisions: string[]
  commitments: Array<{ text: string; action: string }>
}

const DISTILLATION_JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    people: { type: 'array', items: { type: 'string' }, maxItems: 15 },
    accounts: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    decisions: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    commitments: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The commitment as stated, one sentence' },
          action: { type: 'string', description: 'Normalized action verb phrase, 2-4 words, e.g. "send follow-up email", "update crm", "schedule demo"' },
        },
        required: ['text', 'action'],
      },
    },
  },
  required: ['people', 'accounts', 'decisions', 'commitments'],
}

/** Pure: normalized action key for grouping ("Send Follow-Up Email!" → "send follow-up email"). */
export function commitmentActionKey(action: string): string {
  return action.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}

function distillationDoc(note: GranolaNote, extraction: NoteDistillation): string {
  const list = (items: string[]) => items.map((item) => `- ${item}`).join('\n') || '- None identified'
  return [
    `# ${note.title} — meeting note`,
    `\nHeld ${note.createdAt.toISOString().slice(0, 10)}; notes by ${note.ownerName ?? note.ownerRef}.`,
    `\n## Summary\n${note.summary.slice(0, SUMMARY_CHAR_CAP)}`,
    `\n## People\n${list(extraction.people)}`,
    `\n## Accounts\n${list(extraction.accounts)}`,
    `\n## Decisions\n${list(extraction.decisions)}`,
    `\n## Commitments\n${list(extraction.commitments.map((c) => `${c.text} (${c.action})`))}`,
  ].join('\n')
}

type Deps = { generate?: typeof generateStructured; db?: typeof systemPrisma }

async function distillOne(organizationId: string, note: GranolaNote, deps: Deps): Promise<boolean> {
  const generate = deps.generate ?? generateStructured
  const db = deps.db ?? systemPrisma
  const model = process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL

  const raw = await generate({
    schemaName: 'meeting_note_distillation',
    schema: DISTILLATION_JSON_SCHEMA,
    maxTokens: 800,
    model,
    system:
      'You distill one meeting-note summary into structured facts for a private knowledge base. Extract only what the text states: people named, customer/company accounts discussed, decisions made, and COMMITMENTS — concrete things the note-taker or team said they would do. Normalize each commitment to a short action phrase. Never invent items.',
    user: [`Meeting: ${note.title}`, '', note.summary.slice(0, SUMMARY_CHAR_CAP)].join('\n'),
  })
  const extraction = raw as NoteDistillation
  if (!extraction || !Array.isArray(extraction.commitments)) return false

  // Owner attribution: the note owner's email → workspace user, when present.
  const owner = note.ownerRef.includes('@')
    ? await db.user.findFirst({ where: { email: note.ownerRef.toLowerCase() }, select: { id: true } }).catch(() => null)
    : null

  await storeKnowledge({
    organizationId,
    userId: owner?.id ?? null,
    sourceType: 'meeting_note',
    sourceId: note.id,
    title: `${note.title} — meeting note`,
    filename: `meeting-notes/${note.id}.md`,
    visibility: owner ? 'private' : 'organization',
    content: distillationDoc(note, extraction),
    provenance: {
      kind: 'meeting-note-distillation',
      noteId: note.id,
      series: meetingSeriesKey(note.title),
      commitments: extraction.commitments.map((c) => commitmentActionKey(c.action)),
    },
  })

  // Derived commitment events: deterministic rows for the miner, and graph
  // edges via the normal indexActivity path. Dedupe keys make re-distills
  // (shouldn't happen, but) a no-op.
  const series = meetingSeriesKey(note.title)
  const commitmentEvents = extraction.commitments.map((commitment, index) => ({
    source: GRANOLA_SOURCE,
    actorRef: note.ownerRef,
    actorName: note.ownerName,
    action: 'made_commitment',
    entityType: 'commitment',
    entityRef: `${note.id}:${index}`,
    entityName: commitment.text.slice(0, 200),
    businessContext: { series, commitmentAction: commitmentActionKey(commitment.action), noteId: note.id },
    occurredAt: note.createdAt,
    dedupeKey: `granola:commitment:${note.id}:${index}`,
  }))
  await ingestActivity(organizationId, 'sync', commitmentEvents)
  return true
}

/**
 * Distill the not-yet-distilled notes in `notes`, oldest first, capped per
 * run. Never throws — a failed note logs and the rest continue.
 */
export async function distillNewMeetingNotes(
  organizationId: string,
  notes: GranolaNote[],
  deps: Deps = {},
): Promise<{ distilled: number; skipped: number }> {
  const db = deps.db ?? systemPrisma
  let distilled = 0
  let skipped = 0
  try {
    const existing = await db.knowledgeDocument.findMany({
      where: { organizationId, sourceType: 'meeting_note', sourceId: { in: notes.map((note) => note.id) } },
      select: { sourceId: true },
    })
    const done = new Set(existing.map((doc) => doc.sourceId))
    const fresh = notes
      .filter((note) => !done.has(note.id) && note.summary.trim().length > 0)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, MAX_DISTILL_PER_RUN)
    skipped = notes.length - fresh.length

    for (const note of fresh) {
      try {
        if (await distillOne(organizationId, note, deps)) distilled += 1
      } catch (error) {
        apiLogger.warn('notes-distill: note failed', {
          organizationId, noteId: note.id, error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (distilled > 0) apiLogger.info('notes-distill: completed', { organizationId, distilled, skipped })
  } catch (error) {
    apiLogger.warn('notes-distill: run failed', {
      organizationId, error: error instanceof Error ? error.message : String(error),
    })
  }
  return { distilled, skipped }
}
