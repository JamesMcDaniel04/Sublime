# External agents (bring your own agent)

An external agent is a teammate whose work runs somewhere else — a Claude
Agent SDK service, a Managed Agent behind a thin adapter, a function on a
queue. It joins the roster like any agent: it has a name and a face, people
address it from a goal, a profile, or Slack, and its answers land on the
request, the goal, and the thread. The only difference is that Sublime does
not run a tool loop for it. Each ask is POSTed to the agent's endpoint.

Set it up in agent settings → *More settings* → *Where it runs* → *External
service*. Only the agent's owner (or a workspace admin) may change where an
agent runs: the endpoint sees every ask and every answer.

## The contract (`sublime-external-agent/1`)

### Sublime → your endpoint

`POST <endpointUrl>` with the auth you configured (`Authorization: Bearer …`
or a custom header) and this JSON body:

```json
{
  "protocol": "sublime-external-agent/1",
  "runId": "cm…",
  "agentId": "cm…",
  "request": { "id": "cm…", "text": "look at the Acme renewal", "requesterName": "Jamie" },
  "objective": "Monitor renewal risk across named accounts.",
  "input": "look at the Acme renewal",
  "goalId": "cm…",
  "callbackUrl": "https://<your-sublime>/api/agents/<agentId>/external/callback",
  "callbackToken": "…"
}
```

`request` is null for a scheduled or manually triggered run; `objective` is
the agent's standing job so you can frame the ask the way a native run would
(the ask is one task *within* that job). `goalId` is the goal the ask belongs
to, or null — see *Returning work* below.

### Your endpoint → Sublime

Answer in one of two ways:

- **Inline** — respond `200` with `{ "output": "…" }`. The run completes and
  the answer lands on the request. `{ "status": "failed", "error": "…" }`
  fails it instead.
- **Later** — respond `202`. The run parks as *waiting on external agent*.
  When you have the answer, `POST <callbackUrl>` with header
  `x-callback-token: <callbackToken>` and body `{ "output": "…" }` (or
  `{ "status": "failed", "error": "…" }`).

The initial POST is given 30 seconds. Anything that takes longer should
answer `202` and call back.

## Returning work (the coding-agent loop)

An answer may carry tracked work — for a coding agent, the pull request it
opened. Add `work` to the inline response or the callback body:

```json
{
  "output": "Opened PR #42 fixing the login redirect.",
  "work": [
    {
      "subject": "Fix login redirect after SSO",
      "produced": "https://github.com/acme/app/pull/42",
      "subjectRef": "acme/app#42",
      "body": "Changed the callback handler to honour `next`…",
      "assigneeHint": "jamie@acme.com"
    }
  ]
}
```

Each entry lands on the ask's goal as a work item — the same ledger a native
agent's `log_work` writes to — so a person disposes of it (used, edited,
skipped) and its outcome feeds the goal's learning. `subject` and `produced`
are required; `subjectRef` is a stable external id so re-runs do not file the
same PR twice; `assigneeHint` is a name or email and resolves best-effort.
Up to 20 entries per answer.

This is deliberate, not automatic: an answer without `work` stays an answer.
The ask's `goalId` is in the payload; when it is null there is nowhere for
work to land, and Sublime records `external.work_dropped` on the run instead
of failing it.

## What Sublime guarantees

- **The endpoint is vetted twice.** It must be a public https host; it is
  checked when saved and again on every dispatch, and the connection is pinned
  to the vetted address so a DNS rebind cannot redirect the ask inside your
  network.
- **The callback token is single-use and bound to one run.** Its hash lives on
  the run and is cleared by the settle write. A replayed callback, one after a
  cancel, and one after the deadline all get the same `401`.
- **A parked run has a deadline** (default 10 minutes, per agent). If nothing
  calls back by then the run fails and the requester is told.
- **Your secret is ciphertext at rest** and never returned by any API.
- **Every dispatch is audited** with the agent as the actor.

## What Sublime does not do for an external agent

No tools, no transcript, no permission grant: what the agent may touch is
governed where it runs. Its profile says so. It cannot pause to ask the
requester a question (`ask_user`) — answer inline or call back.

## The other direction

An external agent can address a Sublime agent through the workspace MCP
server (`POST /api/mcp`, a workspace API key with `agents:execute`): the
`ask_agent` tool files a request exactly as a person would, and `get_request`
reads the answer. The Sublime agent's objective frames the ask and it may
decline one outside its job.
