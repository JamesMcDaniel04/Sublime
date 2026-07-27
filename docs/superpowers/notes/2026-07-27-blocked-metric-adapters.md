# Blocked Metric Adapters — Accounting and Delivery

**Date:** 2026-07-27
**Status:** Not buildable yet. This is a scoping note, not a spec.

Sub-project 3 of the "goals leverage AI" arc named three metric adapters. GA4 is
specced and buildable (`2026-07-27-ga4-metric-adapter-design.md`). The other two
cannot be built yet, for the same underlying reason: **there is no way for a
Sublime workspace to connect to those systems at all.**

Written down now so the work is not re-derived later.

## The blocker

A metric binding addresses its credentials through `connectionRef`, and
`refId()` in `src/lib/metrics/types.ts` accepts exactly three planes:

```
'credential:<id>' | 'nango:<connectionId>' | 'google:<id>'
```

Each plane has a fixed provider set:

| Plane | Providers available today |
| --- | --- |
| `google` | google-mail, google-calendar, google-sheets, google-drive, google-analytics |
| `nango` | slack, gmail, sheets, drive, calendar, analytics, salesforce (+ hubspot, salesforce-sandbox for metrics) |
| `credential` | vault secrets — Stripe API keys, Postgres connection strings |

QuickBooks, Xero, Linear and Jira appear in none of them. They are absent from
`BUILTIN_CONNECTORS`, from the Nango provider list, and from
`GOOGLE_SERVICE_SCOPES`. Writing an adapter against a connection that cannot
exist would produce a source that is permanently unavailable in the wizard.

## 3b. Accounting adapter (QuickBooks or Xero)

**Goal templates that would use it:** `finance-org-collected-revenue`,
`finance-org-burn-reduction`, `finance-org-gross-margin`,
`finance-org-vendor-savings`, `finance-personal-dso` — currently all on
`postgres` / `google_sheets`.

**What it needs before an adapter is worth writing:**

1. **Pick one.** QuickBooks Online and Xero have different data models; the
   adapter is not portable between them. This is a product call, not a technical
   one — pick whichever your customers actually run.
2. **Nango provider configuration.** Both are OAuth2 and both are supported
   Nango providers, so this is dashboard configuration plus an OAuth app
   registered with the vendor — no new plane needed.
3. **A `ConnectorDescriptor`** in `src/lib/connectors/registry.ts` with
   `kind: 'nango'`, so the integration appears in the UI and can be connected.
4. **Widen the metric-options query** — `available-sources.ts` filters
   `nangoConnection.providerConfigKey` to an explicit list; the new key must be
   added or the connection will exist but never surface as a metric source.

**Then** the adapter itself, which is the small part: report endpoints
(QuickBooks `/v3/company/{id}/reports/ProfitAndLoss`, Xero
`/api.xro/2.0/Reports/ProfitAndLoss`) returning a single scalar per metric.

**Windowing caution:** accounting reports are period-based, the same problem GA4
has. Reuse the GA4 decision — window in the metric key, not in `config`.

## 3c. Delivery adapter (Linear or Jira)

**Goal templates that would use it:** `engineering-org-open-bugs`,
`engineering-personal-bug-backlog`, `engineering-org-deploy-frequency`,
`engineering-org-lead-time`, `engineering-personal-review-turnaround` —
currently all on `postgres` / `google_sheets` / `url`.

This one is harder than accounting, because Linear and Jira **are** already
reachable in Sublime — but through the **MCP plane**, which metric bindings
cannot address. Agents talk to them; goals cannot.

Two ways forward, and the choice is architectural:

**Option A — add them as Nango providers.** Same path as accounting: Nango
provider config, connector descriptor, widen the options query. Straightforward
and consistent with every existing metric source. Cost: a workspace that already
has Linear connected over MCP would have to connect it a *second* time for
goals, which is a genuinely confusing thing to ask.

**Option B — extend the metric plane vocabulary to MCP.** Add an `mcp:<id>`
plane to `refId()` and let a metric binding reuse the org's existing MCP
connection. No second connection, and it would generalize to every future MCP
provider. Cost: MCP servers expose *tools*, not REST endpoints, so the adapter
would call a tool and parse its result — a different execution shape from every
adapter written so far, and tool availability varies per server, so
`availableMetrics()` could no longer be a static list.

Option B is the better end state and the larger project. It should be its own
spec, decided on its own merits, rather than smuggled in under "add a Jira
adapter".

## Recommended order

1. GA4 — specced, buildable now, zero new infrastructure
2. Accounting — one product decision plus routine Nango onboarding
3. Delivery — only after the MCP-plane question is settled

Nothing here is urgent: every one of these goal templates already works on
`google_sheets`, `url` or `postgres`. These adapters upgrade tracking from manual
to exact; they do not unblock anything.
