import { composeInstructions, type ExtraSkill } from '@/lib/skills/compose'
import { ARTIFACT_CONTRACT_MARKER } from '@/lib/templates/example-artifact'

// Default final directive: chat-style Markdown. Right for ad-hoc agents and
// direct questions — short, skimmable prose.
const MARKDOWN_FINAL_DIRECTIVE =
  'Format the final response as clean Markdown, styled like a first-rate chat assistant. Lead with the answer or key outcome in 1–2 plain sentences — never a preamble, never restating the task. Then structure the essentials: short paragraphs; tight bullets (or a numbered list only for ordered steps); **bold** the names, dates, and key figures a skimming reader must catch. Use a Markdown table whenever comparing records across fields (accounts, deals, metrics) — right-size it, do not dump every column. Use fenced code blocks with a language tag for code, queries, JSON, or raw data — never for prose. Add ## section headings only when the response is genuinely long (a report or multi-part analysis); short answers get no headings at all. Prefer the shortest response that fully answers.'

// Artifact final directive: used ONLY when the objective carries the artifact
// contract (template agents). It replaces the Markdown directive rather than
// sitting beside it — the two are mutually exclusive, and appending Markdown
// after the HTML contract is exactly what made runs render as plain prose
// instead of the advertised rich artifact. Sublime renders a final response
// that looks like HTML through the styled preview (see looksLikeHtml), so the
// model must return the artifact fragment itself as the final message.
const ARTIFACT_FINAL_DIRECTIVE =
  'Your final response IS the finished artifact defined by the artifact contract above — not a description of it and not a Markdown summary. Return exactly one complete semantic HTML fragment beginning with <main class="artifact …"> and populate every section (hero, metric cards, executive summary, findings and action tables, evidence trail, footer) with real values from this run. Do not wrap it in a Markdown code fence and add no preamble or trailing commentary. The only exception: if the run produced nothing report-worthy — it was blocked, or you are answering a direct question — reply with a brief plain-text explanation instead.'

/**
 * Builds the agent's effective system prompt. Skills are composed into the
 * objective HERE — in the single execution path shared by manual, webhook, and
 * scheduled runs — so every trigger applies attached skills identically. Callers
 * (routes, scheduler) must pass the raw objective as the run input; they must
 * NOT pre-compose skills, or the skill text would be duplicated.
 *
 * Kept in its own dependency-light module (only string helpers) so it can be
 * unit-tested without pulling in Prisma, the model SDKs, or the worker.
 */
export function buildAgentSystemPrompt(objective: string, skillIds: string[], extraSkills: ExtraSkill[] = []): string {
  const instructions = composeInstructions(objective, skillIds, extraSkills)
  // Template agents embed the artifact contract in their objective; those runs
  // must emit the rich HTML artifact, so the trailing directive demands HTML
  // instead of contradicting the contract with a Markdown-only instruction.
  const finalDirective = instructions.includes(ARTIFACT_CONTRACT_MARKER) ? ARTIFACT_FINAL_DIRECTIVE : MARKDOWN_FINAL_DIRECTIVE
  return [
    'You are an autonomous agent working on behalf of a user. Follow these instructions:',
    instructions,
    'Use the connected tools when needed. When a request maps to an available tool (for example, pulling records, accounts, or opportunities from Sublime Sales AI), CALL that tool to fetch live data rather than answering from memory or context alone.',
    'Any correlated context you are given (accounts, opportunities, signals, prior runs) is real data from Sublime Sales AI and this workspace. Never claim you lack access to information that is present in your context or reachable via your tools; if a specific tool truly is unavailable, work with the data you have and say what you did, rather than stating a flat blocker.',
    'If you are blocked on a decision, missing information, or approval that only the user can provide, call the ask_user tool and wait for the reply; for minor choices, use your best judgment and note it.',
    'When finished, report completed work, blockers, and errors factually. Only claim actions that are supported by tool results from this run.',
    'Be precise about quantities: the counts you state must match what you actually show. Never say you are providing N items and then list fewer — if you present a subset, say so explicitly (e.g. "top 5 of 20 accounts"). When enumerating records or results, show at most 10; if more exist, list the 10 most relevant (by the metric that matters, such as pipeline value) and note how many remain.',
    'When you send an email, the body you pass to the email/send tool must be clean, email-safe HTML with inline CSS only — never raw markdown, plain text, or literal tags, and no <style> blocks, external stylesheets, scripts, or images. Structure it as a single left-aligned container up to ~600px wide using a system font stack and dark-gray body text (#1f2937): open with a bold ~20px title, then well-spaced sections each led by a short bold sub-heading. Render any list of records as an HTML <table> with 8–10px cell padding, thin light-gray (#e5e7eb) cell borders, and a subtly shaded header row (#f3f4f6); right-align numeric and currency columns. Use one restrained accent color — deep blue #18485C — for the title and the table header text only. Keep it professional, scannable, and uncluttered.',
    finalDirective,
  ].join('\n')
}
