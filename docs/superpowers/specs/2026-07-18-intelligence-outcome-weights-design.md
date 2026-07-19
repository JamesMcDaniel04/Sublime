# Intelligence Phase 4: Outcome-Learning Weights

**Date:** 2026-07-18
**Status:** Approved design (phase 4, final phase of the intelligence
hardening; follows phases 1-3)

## Problem

What happened to past suggestions (adopted, dismissed, accepted-then-ignored)
currently informs only the synthesis PROMPT — the LLM is asked to weigh it.
The deterministic layer never learns: a pattern kind whose suggestions a user
dismisses every week keeps flowing through the gate at full strength, and the
platform keeps spending its one weekly suggestion on signal the user has
already rejected.

## Decision summary

- Learn per (user, pattern KIND), deterministically, inside the existing
  eligibility choke point. No new tables, no new surfacing, no LLM.
- Outcomes come from the existing `user_suggestions` rows +
  `suggestionOutcomeLabel` (adoption-aware, richer than accepted/dismissed).
- Self-healing: only the last 20 actioned suggestions within 90 days count,
  so a suppressed kind resurfaces once old rejections age out.

## Module move (dependency direction)

`suggestionOutcomeLabel`, `SuggestionFeedbackRow`, and the adoption window
move from `src/lib/intelligence/suggest-user-workflows.ts` to a new
`src/lib/behavior/outcome-weights.ts` (behavior must not import intelligence;
intelligence already imports behavior). `suggest-user-workflows.ts` re-exports
them so existing imports and tests keep working.

## Deterministic model (`src/lib/behavior/outcome-weights.ts`, pure)

- `patternKindOfSlug(slug)` — slug prefix → kind (`seq:`→sequence,
  `routine:`→temporal, `friction:`→friction, `intent:`→intent,
  `toolcorr:`→tool_correlation, `gap:`→capability_gap, `peer:`→peer_practice,
  `archetype:`→archetype_gap; unknown → null).
- `OUTCOME_SCORES`: accepted-and-adopted **+2**, accepted **+1**,
  accepted-but-never-published **−1**, dismissed **−1**,
  accepted-then-deleted **−2**, anything else 0.
- `computeKindWeights(entries)` — each past suggestion contributes its score
  once to EACH kind its cited slugs map to; weights sum per kind.
- `KIND_SUPPRESS_WEIGHT = −2` — a kind at/below this weight is suppressed.
- `loadOutcomeKindWeights(organizationId, userId, db)` — last 20
  accepted/dismissed suggestions within 90 days, flows joined for adoption
  labels. Never throws; failure → empty map (no learning that day, never a
  broken gate).

## Gate application (`eligibility.ts`, the single choke point)

`isPatternEligible` stays pure and unchanged. `listEligiblePatterns` gains
two deterministic steps after the existing gate filter:

1. **Suppression:** drop patterns whose kind weight ≤ `KIND_SUPPRESS_WEIGHT`.
   The user has repeatedly rejected suggestions grounded in this kind; stop
   grounding suggestions in it until the history decays.
2. **Ranking:** stable-sort by kind weight desc, then occurrenceCount desc —
   kinds that led to adopted automations reach the synthesis prompt first
   (the prompt lists patterns in this order; with many patterns, favored
   kinds are the ones the model sees at the top).

The weights load is wrapped independently of the main try/catch: a failure
degrades to unweighted behavior, not to an empty pattern list.

## Interaction with existing safeguards

- Per-slug dismissal suppression (exact + embedding-similar) is untouched —
  that kills a specific idea; kind weights throttle a whole signal family.
- The synthesis prompt's feedback block stays: the LLM still sees titles and
  outcomes for nuance; the gate now also acts on them deterministically.
- Quietness invariants unchanged.

## Testing

- Pure: slug→kind mapping (every live prefix), outcome scoring, weight
  summation across multi-kind citations, suppression threshold boundary.
- `listEligiblePatterns` with a stubbed db: suppressed kind dropped, favored
  kind ranked first, weights-load failure degrades to unweighted order.
- Existing suggest-user-workflows tests keep passing via re-exports.
