# Backstory Studio → Sublime: flows parity map

Date: 2026-08-24
Reference: `jamesmcdaniel-cyber/Backstory_Studio_Playground` @ `4e86531`
Scope: **flows only** — functional UI and feature enhancements. Agents,
templates-for-agents, assistant and super-admin were covered in
`2026-08-11-backstory-parity.md` and are not re-derived here.

**Scope constraint.** Sublime's visual design is settled. Everything below is
capability or UX behaviour. No restyling, no new design language.

**Framing.** The two trees are siblings — same stack, same layout, same
`0.2.0` version, `backstory-studio` vs `sublime-studio`. They have diverged in
*both* directions. This is a two-way map, not a catch-up list, and the first
section exists so the second is not read as a rewrite mandate.

---

## 0. Where Sublime already leads — do not regress

Verified by migration diff. Backstory has no equivalent of:

| Sublime capability | Migration |
| --- | --- |
| Dispatch outbox (exactly-once trigger fan-out) | `flow_dispatch_outbox` |
| Webhook ingress idempotency | `flow_ingress_idempotency` |
| Side-effect ledger | `flow_side_effect_ledger` |
| Trigger denormalization (indexed trigger lookup) | `flow_trigger_denormalization` |
| Per-user node pins | `flow_node_pins` |
| Jam comments + point anchors | `flow_jam_comments`, `flow_comment_point_anchor` |
| Jam mutation log + access revisions | `flow_jam_mutation_log`, `flow_jam_access_revision` |
| Wait + webhook-response steps | `flow_wait_and_webhook_response` |
| Sub-flow run steps, iteration paths | `flow_run_step_child_flow_run`, `flow_run_step_iteration_path` |
| Structured flow learning | `structured_flow_learning` |
| Slack-bot-owned flows | `slack_bot_flows` |

Sublime also has a far richer **node body library** — 22 dedicated
`nodes/*-body.tsx` modules (router, switch, loop, repeat-until, parallel,
subflow, human-review, error-shield, respond-webhook, transform, variable,
wait, stop…) against Backstory's generic `step-node` / `step-drawer` /
`trigger-editor`. Plus `test-node`, run `feedback`, `resubmit`, and a
`credentials` route Backstory lacks.

**Do not port Backstory's canvas.** Sublime's is `dag-canvas.tsx`; Backstory's
is `graph-canvas.tsx` + `canvas-node.tsx`. These are different engines. Taking
Backstory's would be a canvas rewrite, not a gap-close.

---

## 1. Gaps worth closing, ranked

### Tier 1 — self-contained, clear product value

**1. Flow templates — Sublime has literally none.**
Verified: zero `FlowTemplate` models, zero template routes. Backstory has
`FlowTemplate` + `FlowTemplateVersion` (2 migrations), 6 API routes
(`/api/flow-templates`, `[id]`, `[id]/use`, `[id]/versions`, `draft-notes`),
a detail page, `flow-template-gallery.tsx`, `save-as-template-dialog.tsx`, and
`flow-template-card.tsx`. This is the single biggest functional gap: there is
no way to start a flow from anything but blank, and no way to save a good one
for reuse. Largest item in Tier 1, and the one with the clearest payoff.

**2. Live resource picker (`/api/flows/tool-options`, 48 lines).**
Already logged as open item 7 in the 2026-08-12 review. Runs a **read** tool
and returns its items so the builder can pick a Slack channel / board / record
from a list instead of typing an opaque id. Refuses write tools by
construction, so the picker can never fire a side effect. Small, high daily-UX
value, and the security posture is already reasoned through upstream.

**3. Flow icons and folders.**
`Flow.icon` and `Flow.folder` exist in Backstory (`flow_icon`, `flow_folder`),
in Sublime neither does. Two small schema additions plus
`flow-icon-input.tsx`. Pure organization win once a workspace has more than a
dozen flows.

### Tier 2 — real value, more surface

**4. Execution log + step warnings UI.**
`execution-log.tsx` over `flow_run_step_logs` and `flow_run_step_warnings`.
Sublime records run steps but has no per-step log/warning display of this
shape. Pairs naturally with the run panel that already exists.

**5. Structured output browsing.** `data-tree.tsx` +
`structured-value-view.tsx` — expandable tree over step output. Sublime has
`json-token-view.tsx`, so this is an upgrade rather than a hole; worth a
side-by-side before committing.

**6. Import UX.** `import-curl-dialog.tsx`, `import-notes-panel.tsx`,
`use-flow-import.tsx` over `flow_import_notes`. Sublime has
`import-flow-dialog.tsx` and the `feat/flow-import` work; the delta is
**import notes** (what the converter could not translate, surfaced in the
builder) and cURL import. Check against the existing import branch first —
overlap is likely.

**7. Share links / anonymous share.** `[id]/share`, `[id]/invite`,
`flow_share_links`, `flow_anonymous_share`, `flow_share_token_digest`.
Security-sensitive: the token-digest migration means Backstory already learned
not to store raw share tokens. If this is ported, port the digest with it.

### Tier 3 — do not treat as a gap-close

**8. Huddle — a WebRTC voice subsystem, 32 files.**
`huddle-ice` (ICE servers), `use-flow-huddle.ts`, `peer-recovery.ts`,
`media-errors.ts`, `RTCPeerConnection` / `getUserMedia`, plus AI
`huddle/notes`, `huddle/segment`, `huddle/summary` routes and 6 UI components.
This is a realtime voice product with an AI note-taker, not a flows
enhancement. Sublime already has its own collaboration stack (jam, comments,
point anchors, mutation log, collaborators). Porting this is its own project
with its own spec — it should not ride along inside "close the flow gaps".

---

## 2. One item that is not the win it looks like

**CodeMirror code editor + AI code-assist.** Backstory has `code-editor.tsx`
(79 lines, `@codemirror/*` × 4 deps), `code-assist.tsx` (73), and a
`/api/flows/code-assist` route (71).

Sublime's [`nodes/code-body.tsx`](../../src/components/flows/nodes/code-body.tsx)
is a plain monospace textarea **by documented decision**:

> Deliberately a plain monospace textarea rather than an embedded code editor:
> the NDV's input pane already carries the data being worked on, and a
> dependency-free editor keeps the modal light.

Sublime also enforces a bundle budget (`npm run bundle:check` gates the build).
Adding four CodeMirror packages reverses a considered call and spends budget
that is actively policed. The **AI code-assist** half is separable and may be
worth taking on its own against the existing textarea — that is the part with
real value; syntax highlighting is the part with real cost.

Flagging rather than deciding: this needs a call, not a port.

---

## 3. Suggested order

1. Live resource picker (smallest, immediate daily payoff, already scoped)
2. Flow icons + folders (small schema, organization win)
3. Flow templates (largest Tier 1, biggest product gap)
4. Execution log + step warnings
5. Decide CodeMirror vs. code-assist-only as an explicit call
6. Import notes — only after reconciling with `feat/flow-import`
7. Share links — only with the token digest
8. Huddle — separate spec, separate project, or drop

## 4. Carry-over constraints

- Port capability, render with Sublime's existing components. The UI is
  settled.
- Backstory is Prisma 6; Sublime is Prisma 7 (`src/generated/prisma`, pg
  adapter). Schema and client code do not copy verbatim.
- Backstory has an `edition.config.ts` internal/customer gating system Sublime
  does not. Strip edition gating from anything ported; do not import it.
- Any ported route must go through Sublime's `tenant-guard`, `withAuthenticatedApi`,
  and audit chokepoints — Backstory's equivalents differ.
