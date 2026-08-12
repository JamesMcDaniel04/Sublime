# Credential security & node deactivation — design

Date: 2026-08-11 · Branch: `feat/flow-import`

Four user requirements plus the gaps surfaced while mapping them ("close all
identified gaps"). Each section lists intent, the decision taken, and the files
touched.

## 1. Secrets can never be viewed — reveal shows a generic placeholder

**Today.** No decrypt/reveal path exists anywhere. `GET /api/credentials`
returns presence booleans (`hasToken`, …) via `redactCredential`; the editor
shows blank password inputs with "Unchanged — leave blank to keep it".

**Decision.** Keep the server invariant exactly as is — no reveal endpoint is
added. Make the invariant *visible* in the UI:

- In `credential-editor.tsx`, secret fields that have a stored value render a
  masked placeholder value (`••••••••••••••••`) and an eye toggle. "Revealing"
  swaps the field to the literal generic placeholder
  `sublime-placeholder-key-0000` with helper text explaining that stored
  secrets can never be displayed, only replaced. Typing replaces the secret as
  before; leaving it untouched keeps the stored one.
- Regression tests assert that credential GET responses never contain
  decrypted values and that no `reveal`/decrypt route exists under
  `src/app/api/credentials`.

## 2. Credentials are workspace resources

**Today.** Credentials are private per user: `credentialScope()` in
`src/lib/credentials/resolve.ts` forces `userId`, and every reader funnels
through it. A collaborator running a flow gets `CREDENTIAL_UNAVAILABLE`.

**Decision.** Credentials become workspace-shared (all of them — the request
is explicit). `userId`/`createdById` stay as provenance.

- `credentialScope(organizationId)` drops the user filter (keeps
  `isActive: true`). Legacy quarantined `userId IS NULL, isActive=false` rows
  stay dead.
- All call sites follow: credentials GET/[id]/verify routes, MCP
  `assertOwnedCredential`, `resolveHttpCredential`, `/api/flows/credentials`.
- POST name-clash check becomes org-wide (the `[org, userId, name]` unique
  index stays; app-level check prevents new cross-user clashes).
- Any member can view (redacted), attach, edit, and delete workspace
  credentials — same model as org-shared MCP connections. Audit entries keep
  recording the actor.
- UI: "Personal" badge becomes "Added by <name>" (GET includes creator name);
  privacy copy in editor/picker updated to workspace wording.
- Out of scope: OAuth account connections (Nango/Google) keep their own
  sharing model; the "credentials bank" here is the vault `Credential` table.

Credentials attached while building/importing a flow already land in the vault
(inline literal secrets are rejected at save), so with workspace scoping they
are automatically visible in Integrations → Credentials and usable by invited
members. Requirement 2 needs no separate "save to manager" path.

## 3. Exports never contain credentials — ever

**Today.** `POST /api/flows/[id]/export` accepts `includeCredentials` (owner
scope) which decrypts webhook/agent trigger secrets into the export; the
builder's client-side `downloadFlow()` serializes the raw graph with no
redaction; internal `credentialId`/`connectionId` cuids survive sanitized
exports; the save-time inline-header gate is narrower than the export
redactor; import 400s on inline literal secrets instead of stripping.

**Decisions.**

- Remove the `includeCredentials` capability entirely: schema field, owner
  branch, secret minting, `credentials` block in `PortableFlow`, and the
  credentialed UI menu items. All exports are sanitized; there is no opt-out.
- `downloadFlow()` calls the server portable export instead of serializing
  client state.
- `sanitizeNode` strips `credentialId` and non-portable `connectionId` (cuids)
  from exported nodes; portable ids (`nango:`/`native:`/`template:`) survive.
- Widen `literalSensitiveHeaders` to flag any header whose *name* matches the
  export redactor's `isCredentialKey` regex (runtime `{{refs}}` still pass).
- Import (`/api/flows/import` only) strips inline literal secrets and warns
  per node instead of rejecting the whole document. Direct saves
  (`POST/PUT /api/flows`, Jam patches) keep the hard reject.

## 4. Per-node activate/deactivate

**Today.** `data.disabled` exists on 4 of 23 node types (agent/tool/http/code),
honored in `interpret.ts` before adapters run, imported from n8n for those
types, editable only via Settings → Advanced parameters. No toggle affordance,
no visual state, skipped adapter nodes write no run row, validation still
flags disabled nodes, n8n export drops the flag.

**Decisions.**

- Schema: `disabled: z.boolean().optional()` on every node type except
  `trigger` (deactivating the entry point would deactivate the flow — out of
  scope).
- Interpreter semantics — "skipped while the rest continue on":
  - Generic check in `execNode` for all types; containers skip their bodies.
  - Branch nodes (evaluated in `runOne`): condition → `'true'`, switch →
    `'default'`, router → its default/first branch — deterministic, documented.
  - Output: `mockOutput` if set; else pass-through of the single wired
    parent's output when exactly one parent produced one (keeps downstream
    `{{step.x.output}}` refs working in linear chains, mirroring n8n); else
    no output.
- Run history: `shouldPersistInterpreterStep` learns about status — `skipped`
  steps persist for adapter-persisted types too, so deactivated nodes appear
  greyed in run history instead of vanishing.
- Validation: `validateFlowGraph` skips per-node config errors for disabled
  nodes (structural graph checks still run), so a deactivated half-configured
  node can't block publish.
- UI: "Deactivate"/"Activate" in the step-card context menu and NDV header,
  `d` keyboard shortcut in the builder, dimmed card + "Deactivated" badge on
  both canvases. Advanced-params select stays (same field).
- n8n import: map `disabled` for every mapped type; n8n export emits
  `disabled`. Portable export/import round-trips automatically via node data.

## 5. Bonus gap: imported credential groups are write-only

`Flow.metadata.importedCredentialGroups` is persisted at import but nothing
reads it after the import dialog closes. Add a "bind credentials" affordance
in the flow builder: when unbound groups exist, surface them with a
`CredentialPicker` (same bulk-bind PUT as the import dialog), then clear the
group from metadata once bound.

## Testing

Extend the suites the maps flagged: `src/lib/export/__tests__/*`,
`src/lib/import/__tests__/n8n-import.test.ts`, `flow-import.test.ts`,
`src/features/flows/__tests__/interpret.test.ts`,
`src/app/api/__tests__/credentials-route-smoke.test.ts`,
`src/lib/credentials/__tests__/*`, `src/lib/flows/__tests__/inline-auth.test.ts`.
New assertions: no-credentials-in-export (all targets), scope sharing
(member B resolves member A's credential), disabled-skip for representative
node kinds including branch/container, skipped-row persistence, validation
skip, placeholder reveal.
