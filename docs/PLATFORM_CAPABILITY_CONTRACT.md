# Sublime platform capability contract

This is the implementation-level source of truth for the plan comparison. Marketing copy must not claim an operational service that has not been staffed and verified.

## Knowledge layer

| Capability | Product contract | Implementation |
| --- | --- | --- |
| Knowledge stored | Unlimited durable documents on paid plans, subject to abuse safeguards | `KnowledgeDocument` is the canonical encrypted store for uploads, agent outcomes, flow outcomes, connection profiles, and normalized activity. |
| Connected tools | Unlimited on all paid plans | Billing integration limits are unlimited; Nango, MCP, and native connectors remain user-owned. |
| Live knowledge sync | Included | Activity ingest and connection scans update retained knowledge idempotently by source ID. |
| Retention | On by default | Useful run outcomes are promoted before operational history is pruned. Disconnect removes credentials and live access but preserves redacted learned context by default. |
| Export and deletion | Included | `/api/knowledge` lists or deletes visible knowledge; `?download=1` exports JSON to the authenticated user. Workspace deletion cascades all knowledge. |

## AI, usage, and teams

| Plan | Seats | Credits/month | Specialist areas | Agents/flows | Connected tools |
| --- | ---: | ---: | --- | --- | --- |
| Individual | 5 | 10,000 | One core area | 5 / 5 | Unlimited |
| Team | 10 | 50,000 | Every core area | 25 / 25 | Unlimited |
| Business | 20 | 200,000 | Every core area | Unlimited | Unlimited |
| Enterprise | Custom | Custom | Every core area plus custom scopes | Unlimited | Unlimited |

- Automated workflows and additional paid usage are supported by the flow runtime and Stripe billing foundation.
- Skills have creator-only, workspace, and public sharing controls. Private visibility is the default; workspace/public sharing is included on Team and above.
- Agent and flow history uses explicit ownership boundaries; audit events are append-only and admins can export CSV.
- Custom-engineered scopes are an Enterprise delivery service and require an agreed statement of work; code alone cannot promise delivery capacity.

## Security and privacy

- Retained knowledge and secrets use AES-256-GCM at the application boundary when `ENCRYPTION_KEY` is configured. Production refuses to operate secret encryption without the key.
- Credentials and credential-shaped values are removed before knowledge capture. OAuth access is scoped and revocable.
- Tenant, authenticated-user ownership, and explicit sharing scopes are applied to agents, flows, runs, knowledge, connections, and skills.
- Customer content is not used to train Sublime models, and contracted model providers may use it only to provide the service.
- Enterprise may enable zero-data-retention mode; it disables durable capture and allows temporary execution data to expire.
- MFA, session revocation, audit export, security headers, rate limits, and workspace deletion are implemented platform controls.

## Support

- Individual: always-available documentation and contact intake plus cancel-anytime self-service billing.
- Team and Business: the application can route support and preserve correspondence, but response targets and private-channel availability must be backed by a staffed support process before they are marketed as SLAs.
- Enterprise: dedicated-team and custom-SLA claims require a named owner, escalation rota, response targets, and contract terms. These are operational launch gates, not software flags.

## Billing contract

There is no free trial. A new workspace uses the legacy `TRIAL` enum only as an unpaid sentinel, receives a payment-required response for product APIs, and must complete Stripe checkout before access. Subscription billing starts immediately and can be canceled at any time through the Stripe billing portal; cancellation takes effect according to the current billing-period terms.
