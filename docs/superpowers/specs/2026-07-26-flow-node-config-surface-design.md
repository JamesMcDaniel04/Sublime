# Flow node configuration surface — design

**Date:** 2026-07-26
**Status:** Approved, not yet implemented
**Branch:** feat/goals

## Problem

Configuring a flow node takes too many clicks and shows too much that the node
already implies. Specifically:

1. Clicking a node on the canvas opens `NodeConfigPanel` — a side panel whose
   only real content is a summary `StepCard` and a button that opens the actual
   config surface (the Node Detail View). Two clicks to reach one panel.
2. Every node's Settings tab offers a **Step type** select, which restates what
   the node already is.
3. The NDV Input pane offers a Raw/Fields toggle, and node bodies additionally
   embed their own "Available data" trees — three places showing upstream data.
4. Four node bodies render an **Advanced parameters** accordion inline, mixing
   execution policy into the parameters surface. The HTTP node has its own
   parallel **Options** section doing the same job.
5. Credential entry, save, verification, and cross-flow reuse exist — but only
   on the HTTP node, hardcoded into `http-body.tsx`.

## Goals

- One click from canvas to a node's configuration.
- The Parameters tab shows only what the node *does*; execution policy lives in
  Settings.
- Exactly one place to read upstream data, and it is raw JSON.
- Credential save/verify/reuse is a shared component, reaching the tool node.

## Non-goals

- Changing what the executor does with any of these settings. Every field keeps
  its current runtime semantics; only where it is edited changes.
- New credential types, new auth schemes, or changes to encryption/scoping.
- Reworking the canvas layout, node visuals, or the run/test panels.

---

## 1. Click opens the Node Detail View

**Today:** `StepCard.onClick` → `setSelectedId` → `NodeConfigPanel` renders as a
right-hand `<aside>`. `StepCard.onDoubleClick` → `onOpen` → `openNdv`.

**After:** a single click calls `onOpenNode`. `NodeConfigPanel` is deleted.

### Deletions

- `NodeConfigPanel` (`src/components/flows/dag-canvas.tsx:318-425`) and its
  render site (`:741-756`).
- The `selectedId` / `onSelect` prop chain, wherever it exists only to drive
  that panel. `selectedId` survives internally only where the canvas needs it
  for the selected-node ring; it is no longer a user-facing mode.

### Container children move into the NDV

`NodeConfigPanel` is the only surface that lists a container's children and lets
them be drag-reordered (`dag-canvas.tsx:372-421`). Deleting it without a
replacement would silently remove reordering.

A new `ContainerChildren` component (`src/components/flows/nodes/container-children.tsx`)
carries that list — child `StepCard`s, HTML5 drag-reorder constrained to the same
sibling list, and the existing `AddStepMenu`. It renders inside the NDV body of
every container type: `loop`, `parallel`, `repeatUntil`, `errorShield`.

This requires the NDV to reach `graph`, `onReorderContainer`, and `labelOf`.
They are threaded through `NodeDetailView` → `ParamsPane` → `NodeBodyProps`
alongside the existing `onAddStep`. Clicking a child card opens *that* child in
the NDV (replacing the open node), matching the panel's old `onSelect` behavior.

### Keyboard shortcuts

`src/app/flows/[id]/page.tsx:707-752` binds Delete/Backspace, ⌘C, and ⌘V to
`selectedId`. They rebind to `ndvNodeId`:

| Key | Behavior with a node open | Behavior with nothing open |
|---|---|---|
| Delete / Backspace | Delete that node, close the NDV, toast with undo hint | No-op |
| ⌘C | Copy that node | No-op |
| ⌘V | Paste after that node | Paste at the end of the spine (today's fallback) |
| ⌘Z / ⌘⇧Z | Unchanged | Unchanged |

The existing input/contenteditable guard stays — without it, Backspace inside a
token chip editor deletes the whole step.

Delete and Duplicate also appear as buttons in the NDV header, so the actions are
discoverable and not keyboard-only.

---

## 2. Remove the Step type select

`StepSettingsFooter` (`src/components/flows/ndv/step-settings-footer.tsx`) drops
its Step type block (`:27-38`) and becomes Notes-only.

`onChangeType` is removed from the chain: `page.tsx` → `NodeDetailView` →
`ParamsPane` → `StepSettingsFooter`, and from `step-card.tsx:475`.

**Consequence, accepted:** a wrongly-chosen step is deleted and re-added rather
than converted in place. In-place conversion was the only thing preserving
position and edges; users lose that. This is the intended trade.

`changeNodeType` (`src/lib/flows/mutate.ts:260`) has exactly one caller —
`page.tsx:2197`, this select. Both the call site and the helper are deleted.

---

## 3. Advanced parameters move to the Settings tab

**Today:** `AdvancedParamsSection` is rendered inline by four node bodies —
`agent-body.tsx:227`, `code-body.tsx:91`, `loop-body.tsx:59`, `tool-body.tsx:94`.
The HTTP node instead renders `HttpOptionsSection` (`http-options.tsx:285`) at
`http-body.tsx:523`, covering the same keys plus pagination, batching, cookie,
and retry-status-codes.

**After:** those five call sites are removed from the node bodies. The Settings
tab of `ParamsPane` renders execution policy for every node type:

- `HttpOptionsSection` for `http` nodes.
- `AdvancedParamsSection` for every other node type that has keys, driven by the
  existing `advancedParamKeys(node.type)` manifest — one call site instead of
  four.

Settings tab contents become: Notes, then the policy section. The trigger node
keeps its "no additional step settings" message unless its manifest has keys.

No manifest entries, defaults, or executor reads change. `advanced-params.tsx`
and `http-options.tsx` are unmodified apart from `defaultOpen`, which is set true
now that the section is not competing with parameters for space.

---

## 4. Input pane: clickable raw JSON

**Today:** `InputPane` (`src/components/flows/ndv/input-pane.tsx`) toggles
between a `<pre>` of `JSON.stringify(rawInput)` and a `DataTree` whose leaves
insert tokens on click. Node bodies embed further `DataTree`s via
`tool-args-editor.tsx:229` and `:296`.

**After:** one view — raw JSON, and it is clickable.

### `JsonTokenView`

New component, `src/components/flows/ndv/json-token-view.tsx`. Recursively
renders a value as indented JSON while tracking the dotted path to each position:

- **Leaves** (string, number, boolean, null) and **container keys** (object,
  array) are clickable. Clicking calls `onInsertToken('{{<path>}}')` — the same
  contract `InputPane` already passes down, so nothing downstream changes.
- Clickable spans are `draggable` and set `text/plain` to the braced token,
  preserving drag-into-editor, which works natively on contenteditable.
- Paths derive from the existing input shape (see below). Array indices render
  as `previousNodes.http_1.items.0`.
- Hover shows the token that would be inserted.
- Purely presentational: no data fetching, no graph knowledge, one prop pair
  (`value`, `onInsertToken`).

### Input shape

Unchanged from `node-detail-view.tsx:155-163`:

```json
{
  "trigger":       { "...": "trigger.input" },
  "previousNodes": { "<nodeId>": "that node's output" },
  "item":          "present only inside a loop"
}
```

### What the raw view replaces

- The Raw/Fields toggle and `view` state in `InputPane`.
- `src/components/flows/data-tree.tsx` and its `DataTree` export.
- Both `DataTree` usages in `tool-args-editor.tsx`, and their surrounding
  "Available data" containers.
- The `dataFields` prop chain end to end. It exists solely to feed the deleted
  trees: `page.tsx:816` (`buildDataTree`) → `NodeDetailView` → `ParamsPane` →
  `NodeBodyProps.dataFields` (`nodes/types.ts:53`) → `tool-body.tsx` →
  `tool-args-editor.tsx`. `buildDataTree` goes with it. `src/lib/flows/datatree.ts`
  keeps only the `DataField` / `FieldType` types if a non-UI consumer still
  references them, and is deleted outright otherwise.

The empty state stays: "No upstream data yet — run the flow once, or pin a
step's output…".

The Output pane already renders raw JSON (`output-pane.tsx:54`) and needs no
change.

---

## 5. Shared credential picker, wired to the tool node

### What already exists (unchanged)

- `Credential` model — org-scoped, optionally user-scoped, encrypted
  `authConfig`, `allowedDomains` gating, reusable by any node in any flow.
- `ConnectionVerification` — verification state keyed by connection id, written
  by explicit tests, the OAuth callback, and real runs (so expiry is caught).
- `/api/credentials`, `/api/credentials/[id]`, `/api/credentials/[id]/verify`.
- `CredentialEditor` — the save+verify form.

The user requirement "persistent memory for flows so entered credentials can be
reused" is met by this model today. The gap is reach, not storage.

### Extraction

`src/components/credentials/credential-picker.tsx` lifts, verbatim in behavior,
the block at `http-body.tsx:318-392` plus the dialog at `:525-552`:

```tsx
<CredentialPicker
  value={credentialId}
  type={credentialType}
  onChange={(credentialId, type) => …}
  verifyAgainst={url}          // optional: URL the verify probe hits
  domainHint={hostname}        // optional: filters the list, seeds the name
  context="http" | "tool"
/>
```

It owns: the type select, the domain-filtered `SearchableSelect`, Edit and
Set-up-credential buttons, `CredentialHealth`, the `Dialog` + `CredentialEditor`,
and the list refetch on save. The `/api/credentials` fetch moves inside it.

`http-body.tsx` becomes a consumer. No user-visible change on the HTTP node —
this step is a pure refactor, and `http-curl-auth.test.tsx` must keep passing
untouched as the proof.

### Tool node

The tool node gains a third auth option beside its existing OAuth/MCP
connections: choose or create a stored credential. Selecting one writes
`credentialId` (and `credentialType`) onto the node's data, and the tool
connection id becomes `credential:<id>` — the form `ConnectionVerification` and
`parseFlowToolConnectionId` already recognize.

**This is the only backend work in the spec.** `src/lib/credentials/resolve.ts`
and the tool executor must resolve a `credential:<id>` tool connection into
request auth the same way the HTTP path does via `src/lib/credentials/apply.ts`.
Verification for a tool credential has no URL to probe, so `verifyAgainst` is
omitted and the picker shows the unverified state until a real run writes one.

---

## Testing

Existing suites that must keep passing unchanged (they are the regression net):

- `src/components/flows/__tests__/http-curl-auth.test.tsx` — proves generic auth
  writes no inline secrets; survives the `CredentialPicker` extraction as-is.
- `src/components/flows/ndv/__tests__/node-detail-view.test.tsx`
- `src/lib/export/__tests__/export.test.ts` — never exports credentials inline.
- `src/app/api/__tests__/credentials-route-smoke.test.ts`

New tests:

| Area | Assertion |
|---|---|
| `json-token-view` | Clicking a nested leaf emits `{{previousNodes.http_1.items.0.id}}`; clicking an object key emits the container token; drag sets `text/plain`. |
| `input-pane` | No Raw/Fields toggle renders; empty state renders with no input. |
| NDV settings | Step type select is absent for every node type; the policy section renders in Settings and not in Parameters. |
| Container children | Reordering a loop's children from inside the NDV emits the same `onReorderContainer` call the deleted panel did. |
| Canvas | A single click on a `StepCard` invokes `onOpenNode`; no `NodeConfigPanel` renders. |
| Shortcuts | Delete with a node open deletes it and closes the NDV; Delete with none open is a no-op; the contenteditable guard still blocks Backspace inside a token editor. |
| Tool credentials | A tool node with `credential:<id>` resolves to applied auth at execution (route-smoke against a throwaway Postgres, per the `verify` skill). |

## Risks

| Risk | Mitigation |
|---|---|
| Container reordering is lost with `NodeConfigPanel` | `ContainerChildren` ships in the same change, with a test asserting the reorder callback. |
| Deleting `DataTree` removes a discovery affordance for users who never learned token syntax | `JsonTokenView` keeps click-to-insert on the same data; only the tree presentation goes. |
| Shortcut rebinding breaks muscle memory for users who select-then-delete | Delete/Duplicate also appear as NDV header buttons. |
| Tool credential resolution is real backend surface | Sequenced last; the UI work in §1-4 does not depend on it and can land first. |
| In-place type conversion is gone for good | Accepted explicitly by the user. |
