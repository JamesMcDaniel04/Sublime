# monday.com agent-platform parity — what to take, what we already have

Date: 2026-08-24
Reference: Anthropic customer story, monday.com agent-first rebuild (May 2026 launch,
5M+ agent interactions). Four capabilities: monday Agents, BYOA, Pre-built Agents
store, Claude Coding integration. Five stated lessons.

**Scope constraint.** Sublime's visual design is settled. Everything below is
capability, UX behavior, or architecture. No restyling, no new design language.

**Framing.** monday's rebuild is not "more AI features" — it is a change to the
*unit of work*. Their unit is a board item that a human and a named agent both
act on. Sublime's units are the Goal, the Flow, and the Agent run. We are ahead
of monday on measurement (`Goal`/`GoalWork`/`GoalContribution` has no monday
analog) and roughly level on governance. We are behind on exactly one axis, and
almost every gap below is a facet of it: **an agent in Sublime is a job you
configure and fire, not a party you address.**

---

## 0. Where we already match or lead

Stated so the gap list below is not read as a rewrite mandate.

| monday capability / lesson | Sublime today |
| --- | --- |
| Agents have a name, avatar, role | `AgentWorker` (`name`, `avatarSeed`, `roleLabel`) + roster tiles in [agent-roster.tsx](src/app/(app)/g/[scope]/agents/agent-roster.tsx). Deliberately thin — presentation only, execution stays on `AgentTask`. |
| Agents grounded in live project data | pgvector `embeddingVec(1024)` + HNSW over `KnowledgeDocument`/`AgentMemory`; Neo4j graph; connection scans; `goalGroundingBlock` injects live goal state into every agent prompt. |
| "Capability needs infrastructure to match" (monday DB) | The 2026-07-31 scale pass: bounded Redis producers, per-queue concurrency, atomic status-guarded run claims, dead-letter queues, indexed reaper sweeps, push-based run delivery (`run-events:<orgId>`), denormalized flow triggers. |
| Governance / permissions / transparency | Runtime tenant guard (`src/lib/tenant-guard.ts`), append-only `AuditEvent`, deny-by-default write approvals ([approval.ts](src/features/agents/approval.ts)), three-layer Postgres SQL policy, credential vault with placeholder-only reveal, MFA, audit CSV export. |
| Human in the loop | `ask_user` tool → run parks as `waiting_for_input` → `/api/executions/:id/reply` resumes with the saved transcript. |
| Agent teams | Multi-agent handoff via the `run_agent` tool (depth-bounded, optional `subagentIds` allow-list) — [execute-agent.ts:839](src/features/agents/execute-agent.ts#L839). |
| "Build on what already works" | Goals as the measurement spine, with contributions labeled measured / estimated / correlated. This is our version of monday's "place where teams drive outcomes," and it is a genuine differentiator. |

---

## 1. BYOA — there is no way for an external agent to join the roster

**The finding.** Every `AgentTask` executes through one path: the model
tool-calling loop in [execute-agent.ts](src/features/agents/execute-agent.ts),
against `src/lib/llm/model-runner.ts`. `AgentTask.agentType` is effectively a
two-value field (`CUSTOM` / `SYSTEM`) — there is no runtime discriminator. MCP
brings **tools** in ([mcp-client.ts](src/lib/mcp/mcp-client.ts)); nothing brings
an **agent** in.

The inverse is also missing: there are no workspace API keys or personal access
tokens in `prisma/schema.prisma`, and no Sublime-hosted MCP server (the old
`sublime-mcp.ts` was deleted in the Klavis migration). The only session-less
inbound door is the per-agent trigger secret
([trigger-secret.ts](src/lib/agents/trigger-secret.ts)). So an external agent can
neither *be* a Sublime teammate nor *read* Sublime's work.

**Why it matters.** This is monday's single largest structural bet. BYOA is what
turns "one person built an agent" into "the team has a new teammate" — and it is
the capability that lets a customer's existing Claude Agent SDK / Managed Agent
investment land inside the workspace instead of competing with it.

**What to build.**
- Add a runtime discriminator to `AgentTask` (`runtime: 'native' | 'external'`)
  and an `ExternalAgentBinding` row: endpoint, auth mode (reuse
  `McpConnection.authType` semantics: none / api_key / oauth2), invoke contract,
  callback secret. Reuse `AgentConnector.kind` vocabulary rather than inventing one.
- Dispatch adapter: on execute, POST the objective + grounding block outward,
  park the run as `waiting_for_input`-adjacent (`waiting_for_external`), and
  resume via a callback route modeled on
  [/api/agents/[id]/trigger/route.ts](src/app/api/agents/[id]/trigger/route.ts)
  — the per-agent secret pattern already exists and is already the one
  session-less route the tenant guard tolerates.
- Inbound direction: workspace-scoped API keys + a Sublime MCP server exposing
  goals, agents, runs, and knowledge under the *same* `agentReadScope` /
  `mcpConnectionScope` visibility rules the app uses. Do not fork the scoping.

**Dependency note.** Item 5 (coding agents) is the same adapter. Build the
external-agent runtime once; ship it twice.

---

## 2. No assignment surface — agents cannot be addressed, only fired

**The finding.** Sublime has exactly three ways to start agent work
(ARCHITECTURE.md § Agent Execution): manual `POST /api/agents/:id/execute`, the
BullMQ schedule registrar, and the webhook trigger. All three are
machine-shaped.

Slack mentions *do* reach the platform — `app_mention` is subscribed in
[manifest.ts](src/lib/slack/manifest.ts) and normalized in
[payload.ts](src/lib/slack/payload.ts) — but
[dispatch.ts](src/lib/slack/dispatch.ts) matches them against **flows** with a
`slack` trigger. An agent cannot be mentioned. In-app, `FlowComment` exists as a
threading model but only for flows, and `GoalWork.assigneeUserId` is documented
as a `User.id` — an agent cannot be an assignee.

**Why it matters.** monday calls this out as the pattern that separates their
customers from stalled ones: "many enterprises want to put AI to work, but often
stall at an AI chat that runs parallel to where they actually do the work." Our
agent chat (`AgentChatSession`) and home assistant are precisely that parallel
chat. The teammate framing is currently cosmetic — the avatar exists, the
addressability does not.

**What to build.**
- **Agent-level Slack binding.** Extend the flow-trigger match in
  `dispatch.ts` to also resolve agents by name/handle, so `@Riley summarize the
  Acme renewal risk` enqueues that agent's run with the thread as input.
  `SlackThreadSession` already carries thread memory.
- **Agent as assignee.** Widen `GoalWork.assigneeUserId` to a polymorphic
  assignee (`assigneeKind: 'user' | 'agent'`), so goal work can be routed to an
  agent from the surface where the work is visible. This is the single highest
  leverage change on this list relative to its size.
- **In-app mention.** Generalize `FlowComment` into a comment thread attachable
  to a goal, a run, or a work item, with `@agent` resolution.

---

## 3. Agent identity does not travel with the work

**The finding.** The avatar and role label live only in the roster tiles. The
Slack delivery path ([post.ts](src/lib/slack/post.ts),
[deliver.ts](src/lib/slack/deliver.ts)) sets no `username` or `icon_url` — agent
output arrives as the generic Sublime bot. There is also no agent profile route:
`src/app/(app)/g/[scope]/agents/` is a single page and selection is a `?agent=`
query param ([page.tsx:353](src/app/(app)/g/[scope]/agents/page.tsx#L353)).

**Why it matters.** A teammate has a face where they speak and a profile you can
open. Right now Sublime's agents have a face only on the page where you
configure them — the one place their identity is least load-bearing.

**What to build.** Pass `username` + `icon_url` (or a Block Kit context row with
the generated portrait) through the Slack and email delivery paths; give agents
a real `/agents/[id]` route with run history, memories, connectors, and the
goals they contribute to. The avatar generator
([avatar.ts](src/lib/agents/avatar.ts)) already produces a stable portrait from
`avatarSeed` — it just needs to be served as an image URL.

---

## 4. Agent permissions are capability-level, not identity-level

**The finding.** An agent's authorization is the union of two things: the
connectors bound to it (`AgentConnector`) and `visibility` (`private` /
`shared`). Credentials resolve through `mcpConnectionScope(organizationId,
userId)` and, for Nango delivery, through the **agent owner's** connection —
[execute-agent.ts:300](src/features/agents/execute-agent.ts#L300), commented
"messages arrive as the rep." So an agent inherits a human principal wholesale.

Audit rows record `actorKind: 'agent'` with `actorUserId` set to the borrowed
human ([execute-agent.ts:1090](src/features/agents/execute-agent.ts#L1090)).
Which agent acted is recoverable via `executionId → AgentExecution.agentTaskId`,
so traceability is intact — the gap is **authorization**, not forensics.

**Why it matters.** monday's third lesson is blunt: "Governance, permissions,
transparency, and reliability determine whether agents move beyond pilot
programs and into production." Their agents ship with access permissions and
restrictions of their own. Ours cannot be restricted below the human they run
as. For an enterprise buyer, "the agent can do anything its owner can do" is the
sentence that ends the deal.

**What to build.**
- An agent principal: `AgentTask` gains a scope grant (channels it may post to,
  record types it may write, Postgres connections it may reach) enforced in
  `loadTools` / the plane loaders, not just in the tool list it was handed.
- Per-agent write ceilings independent of `requireApproval` — the
  `alwaysRequiresApproval` registry flag already proves the pattern works.
- `actorAgentId` on `AuditEvent` so the agent dimension is queryable without a
  join through executions.

---

## 5. No coding-agent loop (business need → working code → back to the business user)

**The finding.** Sublime has sandboxed code *execution* — QuickJS
([run-js.ts](src/lib/code/run-js.ts)) and Pyodide
([run-python.ts](src/lib/code/run-python.ts)) behind the flow Code node — but
nothing that plans engineering work, dispatches it to a coding agent running in
the customer's own environment, and lands the result back on the originating
item. The engineering seeds in
[catalogue.ts](src/lib/templates/catalogue.ts) (github / linear / jira) stop at
reporting and triage.

**Why it matters.** This is monday's fourth capability and the one with the
clearest ROI story. It is also the one that most obviously needs our existing
pieces: the pause/resume transcript machinery, the traces plane, and the
approval gate.

**What to build.** The BYOA adapter from item 1, pointed at a coding agent, plus
a plan artifact handoff — [plan-artifact.ts](src/features/agents/plan-artifact.ts)
already exists for goal work and is the right serialization boundary. Result
lands as a `GoalWork` row or a run output with a diff/PR link, then hands to a
human reviewer or the next agent.

---

## 6. The template catalogue is a seed list, not a store

**The finding.** `SEED_CATALOGUE` is ~40 curated seeds across 5 departments
([catalogue.ts](src/lib/templates/catalogue.ts)), provisioned into native
agents, with `TemplateAdoption` tracking uptake. `SharedSkill` has real sharing
controls (`private` / `organization` / `public`) and an `authorName`. Both are
good. Neither is a store: no publisher identity beyond a string, no versioning,
no update path for an installed template, no third-party submission, and no way
for an installed unit to be anything other than a native prompt-driven agent.

**Why it matters.** monday's store turns Claude plugins into specialized
teammates — legal, finance — which is how they get vertical depth without
building it. `SharedSkill` is one migration away from being that primitive.

**What to build.** Version + publisher on `SharedSkill`, an install record
distinct from the definition, and — once item 1 lands — allow a store entry to
install as an *external* agent binding rather than a prompt.

---

## 7. Human-in-the-loop is per-run, not a queue

**The finding.** `waiting_for_input` runs are grouped in the agent activity pane
([agent-activity-pane.tsx:51](src/app/(app)/g/[scope]/agents/agent-activity-pane.tsx#L51))
and surfaced via the notification bell. There is no consolidated "needs a human"
inbox spanning agents, flows, and goal work; no SLA or aging; no delegation or
reassignment; no bulk decision.

**Why it matters.** At monday's stated volume — 5M interactions — the approval
queue *is* the product surface for most users on most days. Our approval design
is genuinely good (deny-by-default, qualified replies count as denials, approvals
never auto-answered from memory). It just has no home.

**What to build.** One inbox route aggregating `waiting_for_input` executions,
paused flow runs, `pending` `GoalWork`, and `goal_action` `UserSuggestion` rows,
with age and a single-key decision. Reuse `notificationHref` routing.

---

## 8. Run the "AI dust" audit on ourselves

monday's first lesson is the sharpest one and it is aimed at us as much as at
their old product: *"We were building 'AI dust' — sprinkling automations onto
existing workflows... Our features helped users summarize text and categorize
information, but they weren't creating sustained usage patterns."*

Candidate dust in Sublime, worth measuring before defending:

- Template **AI search** ([ai-search.ts](src/lib/templates/ai-search.ts)) — an
  LLM answering in a side panel while the grid stays unfiltered (this was
  already flagged in the 2026-08-11 backstory parity review).
- Run **Q&A** (`POST /api/chat`) — summarize-what-just-happened.
- Activity **headlines** — categorization.
- The **home assistant** panel — a chat that runs parallel to the work, which is
  the exact anti-pattern monday names.

Against that, the surfaces that plausibly *do* create sustained usage: goal
tracking with assisted metric extraction, `GoalWorkRule` (lessons derived from
what humans did with agent output — genuinely native AI, no monday analog), and
the flow builder. The audit question for each surface is monday's: **does
removing this change how work gets done, or only how it gets described?**

---

## 9. Non-code lessons worth acting on

- **"The mental model is harder to change than the technology."** Our own
  vocabulary still says *task* (`AgentTask`), *worker* (`AgentWorker`),
  *execute*. monday deliberately says teammate, assign, mention. Renaming the
  schema is not worth it; renaming the **UI vocabulary** probably is, and it is
  cheap.
- **"Adoption depends on trust as much as capability."** We have unusually
  strong material here — append-only audit, deny-by-default writes, three-layer
  SQL policy, tenant guard with a route-smoke regression net. None of it is
  visible to a buyer. A trust surface (what this agent may do, what it did, who
  approved it) is a product feature, not a docs page.
- **Pricing.** Our contract is credits + seats
  ([PLATFORM_CAPABILITY_CONTRACT.md](docs/PLATFORM_CAPABILITY_CONTRACT.md)).
  monday explicitly lists pricing as one of the six things in motion during the
  rebuild. If agents become teammates, "agents/flows: 5 / 25 / unlimited" is the
  wrong shape — a teammate is not a quota.

---

## Suggested sequence

Ordered by dependency, then by leverage per unit of work.

1. **Agent as assignee** on `GoalWork` + agent-level Slack mention routing
   (items 2). Small, unblocks the teammate framing, uses surfaces that exist.
2. **Agent identity in delivery** + `/agents/[id]` profile (item 3). Small,
   visible, makes item 1 feel real.
3. **Agent principal / scoped permissions** (item 4). Enterprise gate. Must
   precede BYOA — an external agent with a borrowed human principal is strictly
   worse than a native one.
4. **External agent runtime** (item 1). The structural piece.
5. **Coding-agent loop** (item 5) — same adapter, second product.
6. **Approval inbox** (item 7) — becomes load-bearing as 1–5 raise volume.
7. **Store** (item 6) — needs 1 and 4 to be worth building.

Items 8 and 9 are audits and decisions, runnable in parallel with all of it.
