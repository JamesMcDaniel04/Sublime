# Behavioral Intelligence — Competitive Parity Checklist

**Date:** 2026-07-11 · Synthesized from 5 research streams: Attio, Day.ai, Zapier, Relevance AI, LemonLime (YC S26 — the user's referenced product), Bardeen, HubSpot Breeze, Rox, Glean, Microsoft Copilot Studio/Power Automate, Lindy, Gumloop. Raw notes: `.superpowers/sdd/parity-notes.md`.

## Where our design LEADS the field

- **Proactive on-connect learning** — only LemonLime and Bardeen do this; Zapier, Lindy, Gumloop, Relevance are all pull-only (user must prompt). ✅ built (Tasks 1–2)
- **Cross-tool graph correlation for suggestions** — most competitors are embeddings-over-sources; explicit cross-tool synthesis with a knowledge graph matches only Rox/Glean-class architecture. ✅ designed (Task 3)
- **≥3-integration context gate** — nobody publishes an equivalent; principled answer to cold-start suggestion quality. ✅ designed (Task 3)
- **Improvement pass over existing flows/agents** — only Microsoft ships this (process mining recommendations); Glean, Attio, Zapier, Lindy, Gumloop do not. ✅ designed (Task 3)
- **Suggestion mechanics** — ≤3 ranked, deduped, labeled, accept/dismiss with dismissal memory: near-identical to Microsoft's Copilot-memory agent suggestions (GA July 2026). ✅ designed

## Table-stakes checklist (pass required before prod)

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Visible learning progress on connect (Attio tracker, Glean 2-phase, LemonLime study period) | ✅ notification + "Your data takes shape" strip (Task 2) |
| 2 | **"What was learned" view — inspect, correct, delete individual learnings** (Lindy Memories is the benchmark) | ❌ GAP → Task 4.5 |
| 3 | **Per-connection learning opt-out** (LemonLime per-tool scoping; Glean per-source rules) — org-wide toggle alone is insufficient | ❌ GAP → Task 4.5 |
| 4 | **Purge learnings when a connection is deleted** (Glean delete-instance purges ≤5 min; LemonLime purges on disconnect) | ❌ GAP → Task 4.5 |
| 5 | Suggestions land as drafts; human activates; nothing auto-publishes | ✅ designed (Task 3) |
| 6 | Suggestion dedupe + dismissal memory (never re-suggest a dismissed idea) | ✅ designed (Task 3, embedding dedupe) |
| 7 | Auto-generated content clearly labeled with provenance (source run/scan) | ✅ designed (Tasks 3–4) |
| 8 | Read-only scanning, minimal scope, distilled-only retention (stronger than Glean/Day.ai raw retention; matches Zapier/Lindy no-training posture) | ✅ built (Task 1) — document in security copy |
| 9 | Learned facts carry provenance/citations (Day.ai benchmark: every claim links to source) | ✅ partial — insights name their source connection; RAG citation contract shipped earlier |
| 10 | Org's own template library prioritized over community; org-scoped privacy for auto-generated | ✅ designed (Task 4) |
| 11 | Caps + eviction hygiene on auto-generated artifacts | ✅ designed (Tasks 3–4) |
| 12 | Permissions-aware answers (Glean/LemonLime trim to asker's source permissions) | ⚠️ accepted divergence: scans use org service identity; org-shared by design — document |

## Deferred (differentiators, not blockers)

- AI troubleshooting/repair of failed runs (Zapier/Microsoft) — separate effort
- Behavior observation beyond tool sampling (Bardeen-style task mining) — separate effort
- Per-agent model cards (HubSpot) — docs polish later
