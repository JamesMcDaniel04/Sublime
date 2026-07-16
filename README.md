# Sublime

Sublime is a focused AI-agent workspace: create agents, connect tools, run tasks, inspect live tool calls and errors, and ask follow-up questions about an execution.

## Product Surface

- `/dashboard`: agent list, grouped run activity, output, tool calls, errors, per-agent run history, and follow-up chat
- `/integrations`: Nango accounts, Slack, Granola, MCP servers, and service configuration
- `/connections`: custom per-user MCP server connections
- `/templates`: reusable agent templates and skills
- `/flows`: visual workflows, triggers, run activity, and version history
- `/settings`: profile, security, members, and workspace configuration

## Architecture

- Next.js App Router owns the UI and authenticated API routes.
- Supabase owns user authentication.
- Prisma/PostgreSQL stores tenants, agents, executions, tool events, templates, and connection state.
- One Fastify/BullMQ worker runtime executes manual and scheduled agents.
- Nango provides embedded integration account connections.
- Anthropic Claude is the default model provider; Qwen is available through its Anthropic-compatible endpoint.

## Local Setup

```bash
cp .env.example .env.local
npm install
npm run db:push
npm run dev:all
```

The web app runs on `http://localhost:3000`; the worker health endpoint runs on `http://localhost:3002/health`.

Supabase projects must install [`supabase/handle-new-user.sql`](supabase/handle-new-user.sql) so every authenticated user receives a tenant and matching Prisma user record.

## Commands

```bash
npm run dev          # Next.js only
npm run dev:all      # Next.js plus the worker runtime
npm run check        # typecheck, lint, and production build
npm run db:migrate   # create a Prisma migration
npm run db:deploy    # apply migrations in production
```
