import type { FlowGraph } from '@/lib/flows/graph'

/**
 * Starter flow templates — ready-to-run 3–5 step flows shown on the Flows page.
 *
 * Portability rules (what makes these work for ANY workspace):
 *   - Tool steps only use plane-scoped connection ids (`nango:<capability>`,
 *     `native:<provider>`) which resolve to the org's own connection at
 *     runtime — never a concrete MCP row id.
 *   - Agent steps are inline prompts (blank agentId) so no saved agent is
 *     required; structured steps declare outputFields so downstream tool args
 *     can map their fields.
 *   - Anything user-specific (channel, repo, recipient) is a typed flow input
 *     with a sensible default where one exists — the run prompt collects the
 *     rest. No graph editing required to get a working run.
 */
export type StarterTemplate = {
  key: string
  name: string
  description: string
  category: string
  /** Natural-language build brief users can paste directly into Flow Copilot. */
  copilotInstructions: string
  /** Styled illustrative result shown on the template detail page. */
  exampleOutput: string
  /** Integration display names the user must have connected for the flow to run. */
  requires: string[]
  trigger: { type: 'manual' }
  graph: FlowGraph
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    key: 'meeting-recap-slack',
    name: 'Meeting recap to Slack',
    description: 'Pull your latest Granola meeting notes, summarize the decisions and action items, and post a recap to a Slack channel.',
    category: 'Meetings',
    copilotInstructions: `Build a manual flow called “Meeting recap to Slack.”

1. Add a text input named channel with #general as the default.
2. Use Granola to fetch the most recent meeting notes.
3. Add an AI step that turns those notes into a concise Slack recap. Include a one-line header, 2–3 bullets per meeting, key decisions, and action items with owners when available. Use Slack formatting and do not invent missing details.
4. Post the AI step output to the selected Slack channel.

Keep the steps connected in that order. If Granola returns no notes, post a clear message saying there were no recent meetings.`,
    exampleOutput: `<section><p><strong>Weekly product sync recap</strong></p><ul><li><strong>Decision:</strong> Move the onboarding release to Thursday after QA signs off.</li><li><strong>Customer signal:</strong> Three teams asked for Salesforce activity history in the workspace.</li><li><strong>Action:</strong> Maya owns the release checklist; Alex will confirm migration timing by Wednesday.</li></ul></section>`,
    requires: ['Granola', 'Slack'],
    trigger: { type: 'manual' },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
        {
          id: 'params',
          type: 'input',
          data: {
            label: 'Recap settings',
            params: [
              { name: 'channel', type: 'string', required: true, default: '#general', description: 'Slack channel to post the recap in.' },
            ],
          },
        },
        {
          id: 'notes',
          type: 'tool',
          data: {
            label: 'Fetch recent meeting notes',
            connectionId: 'native:granola',
            toolName: 'list_notes',
            args: '{}',
            retries: 1,
          },
        },
        {
          id: 'recap',
          type: 'agent',
          data: {
            label: 'Write the recap',
            agentId: '',
            prompt:
              'From the meeting notes above, write a concise Slack recap of the most recent meetings: 2-3 bullet points per meeting covering key decisions and action items (with owners when named). Use Slack formatting (*bold*, - bullets). Start with a one-line header. If there are no notes, say there were no recent meetings.',
            input: 'Meeting notes: {{step.notes.output}}',
            includeUpstream: false,
          },
        },
        {
          id: 'send',
          type: 'tool',
          data: {
            label: 'Post to Slack',
            connectionId: 'nango:slack',
            toolName: 'slack_post_message',
            args: '{"channel":"{{input.channel}}","text":"{{step.recap.output}}"}',
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'params' },
        { id: 'e2', source: 'params', target: 'notes' },
        { id: 'e3', source: 'notes', target: 'recap' },
        { id: 'e4', source: 'recap', target: 'send' },
      ],
    },
  },
  {
    key: 'research-brief-email',
    name: 'Research brief by email',
    description: 'Research any topic with Perplexity, distill it into a crisp brief, and email it to yourself or a teammate.',
    category: 'Research',
    copilotInstructions: `Build a manual flow called “Research brief by email.”

1. Ask for two required inputs: topic and recipient email address.
2. Search the topic with Perplexity.
3. Add an AI step that converts the research into a two-minute brief with a two-sentence summary, 4–6 concise findings, and a final “why it matters” line. Preserve source-grounded facts and do not add unsupported claims.
4. Send the finished brief through Gmail with the subject “Research brief: <topic>.”

Map the topic and recipient inputs into the appropriate steps and pass the complete research response into the AI step.`,
    exampleOutput: `<article><h2>Research brief: AI workflow adoption</h2><p>Teams are moving from isolated assistants toward governed workflows that connect directly to operational systems. The strongest adoption appears where outputs are measurable and human review remains explicit.</p><h3>Key findings</h3><ul><li>Connected workflows shorten handoffs between research and execution.</li><li>Auditability and permission boundaries remain purchase requirements.</li><li>Reusable templates reduce time to first value for new teams.</li></ul><p><strong>Why it matters:</strong> Products that combine fast setup with visible controls are positioned to expand beyond early adopters.</p></article>`,
    requires: ['Perplexity', 'Gmail'],
    trigger: { type: 'manual' },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
        {
          id: 'params',
          type: 'input',
          data: {
            label: 'What to research',
            params: [
              { name: 'topic', type: 'string', required: true, description: 'The topic or question to research.' },
              { name: 'to', type: 'string', required: true, description: 'Email address to send the brief to.' },
            ],
          },
        },
        {
          id: 'search',
          type: 'tool',
          data: {
            label: 'Research with Perplexity',
            connectionId: 'nango:perplexity',
            toolName: 'perplexity_search',
            args: '{"query":"{{input.topic}}"}',
            retries: 1,
          },
        },
        {
          id: 'brief',
          type: 'agent',
          data: {
            label: 'Write the brief',
            agentId: '',
            prompt:
              'Turn the research above into a brief a busy teammate can read in two minutes: a 2-sentence summary, 4-6 key findings as short bullets, and a "why it matters" closing line. Plain text, no markdown headers.',
            input: 'Topic: {{input.topic}}\n\nResearch: {{step.search.output}}',
            includeUpstream: false,
          },
        },
        {
          id: 'send',
          type: 'tool',
          data: {
            label: 'Email the brief',
            connectionId: 'nango:gmail',
            toolName: 'gmail_send_email',
            args: '{"to":"{{input.to}}","subject":"Research brief: {{input.topic}}","body":"{{step.brief.output}}"}',
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'params' },
        { id: 'e2', source: 'params', target: 'search' },
        { id: 'e3', source: 'search', target: 'brief' },
        { id: 'e4', source: 'brief', target: 'send' },
      ],
    },
  },
  {
    key: 'bug-report-github',
    name: 'Bug report to GitHub issue',
    description: 'Paste a raw bug report and get a well-structured GitHub issue with a clear title, repro steps, and expected behavior.',
    category: 'Engineering',
    copilotInstructions: `Build a manual flow called “Bug report to GitHub issue.”

1. Ask for repository owner, repository name, and a raw bug report.
2. Add an AI step that returns structured title and body fields. The title must be imperative, specific, and under 70 characters. The body must contain Summary, Steps to reproduce, Expected behavior, and Actual behavior sections. Mark unknown details as “Needs info” instead of inventing them.
3. Use GitHub to create an issue in the selected repository with the structured title and body.

Bind the three inputs to the AI and GitHub steps, and only create the issue after the structured response succeeds.`,
    exampleOutput: `<article><h2>Prevent duplicate flow runs after webhook retry</h2><h3>Summary</h3><p>A retried webhook can create a second run for the same delivery.</p><h3>Steps to reproduce</h3><ol><li>Publish a webhook-triggered flow.</li><li>Send the same delivery ID twice.</li><li>Open flow activity.</li></ol><h3>Expected behavior</h3><p>One run is recorded for the delivery ID.</p><h3>Actual behavior</h3><p>Two runs are created.</p></article>`,
    requires: ['GitHub'],
    trigger: { type: 'manual' },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
        {
          id: 'params',
          type: 'input',
          data: {
            label: 'Bug details',
            params: [
              { name: 'owner', type: 'string', required: true, description: 'Repository owner (user or org).' },
              { name: 'repo', type: 'string', required: true, description: 'Repository name.' },
              { name: 'report', type: 'string', required: true, description: 'The bug report, in whatever shape you have it.' },
            ],
          },
        },
        {
          id: 'draft',
          type: 'agent',
          data: {
            label: 'Draft the issue',
            agentId: '',
            prompt:
              'Turn this bug report into a well-formed GitHub issue. Title: imperative, specific, under 70 characters. Body: markdown with sections for Summary, Steps to reproduce (numbered, inferred where reasonable), Expected behavior, and Actual behavior. Do not invent details you cannot infer; mark unknowns as "Needs info".',
            input: 'Bug report: {{input.report}}',
            includeUpstream: false,
            responseFormat: 'structured',
            outputFields: [
              { name: 'title', type: 'string', description: 'Issue title' },
              { name: 'body', type: 'string', description: 'Issue body (markdown)' },
            ],
          },
        },
        {
          id: 'create',
          type: 'tool',
          data: {
            label: 'Open the issue',
            connectionId: 'nango:github',
            toolName: 'github_create_issue',
            args: '{"owner":"{{input.owner}}","repo":"{{input.repo}}","title":"{{step.draft.output.title}}","body":"{{step.draft.output.body}}"}',
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'params' },
        { id: 'e2', source: 'params', target: 'draft' },
        { id: 'e3', source: 'draft', target: 'create' },
      ],
    },
  },
  {
    key: 'request-to-asana',
    name: 'Request to Asana task',
    description: 'Turn a rough request from chat or email into a clean, actionable Asana task in the right project.',
    category: 'Operations',
    copilotInstructions: `Build a manual flow called “Request to Asana task.”

1. Ask for the raw request and the destination Asana project GID.
2. Add an AI step that produces structured name and notes fields. The name should be verb-first and under 80 characters. The notes should preserve the request context and convert the desired result into acceptance-criteria bullets. Do not invent deadlines or assignees.
3. Create the task in Asana using the supplied project GID and the AI-generated name and notes.

Keep the original request available to the AI step and stop the flow if the structured response cannot be produced.`,
    exampleOutput: `<article><h2>Publish the Q3 onboarding checklist</h2><p>Turn the approved onboarding process into a checklist the customer-success team can reuse.</p><h3>Acceptance criteria</h3><ul><li>Includes owners for every onboarding stage.</li><li>Links the required CRM and support-system fields.</li><li>Documents the handoff from sales to customer success.</li><li>Is reviewed by the operations lead before publishing.</li></ul></article>`,
    requires: ['Asana'],
    trigger: { type: 'manual' },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
        {
          id: 'params',
          type: 'input',
          data: {
            label: 'The request',
            params: [
              { name: 'request', type: 'string', required: true, description: 'The request, pasted as-is.' },
              { name: 'project_gid', type: 'string', required: true, description: 'Asana project gid (from the project URL).' },
            ],
          },
        },
        {
          id: 'draft',
          type: 'agent',
          data: {
            label: 'Shape the task',
            agentId: '',
            prompt:
              'Turn this request into an actionable task. Name: a verb-first task title under 80 characters. Notes: the request restated as acceptance criteria bullets, plus any context worth keeping. Do not invent deadlines or assignees.',
            input: 'Request: {{input.request}}',
            includeUpstream: false,
            responseFormat: 'structured',
            outputFields: [
              { name: 'name', type: 'string', description: 'Task title' },
              { name: 'notes', type: 'string', description: 'Task description' },
            ],
          },
        },
        {
          id: 'create',
          type: 'tool',
          data: {
            label: 'Create the task',
            connectionId: 'nango:asana',
            toolName: 'asana_create_task',
            args: '{"project_gid":"{{input.project_gid}}","name":"{{step.draft.output.name}}","notes":"{{step.draft.output.notes}}"}',
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'params' },
        { id: 'e2', source: 'params', target: 'draft' },
        { id: 'e3', source: 'draft', target: 'create' },
      ],
    },
  },
  {
    key: 'call-notes-salesforce',
    name: 'Call notes to Salesforce',
    description: 'Paste raw call notes and log a tidy activity in Salesforce. The subject and summary are written for you.',
    category: 'Sales',
    copilotInstructions: `Build a manual flow called “Call notes to Salesforce.”

1. Ask for raw call notes.
2. Add an AI step that returns structured subject and description fields. Format the subject as “Call — <company or person> — <outcome>” and keep it under 80 characters. Put the outcome first in the description, followed by concise discussion bullets and explicit next steps. Preserve every commitment and number; invent nothing.
3. Create a completed Task record in Salesforce with the generated subject and description.

Pass the notes directly into the AI step and map its structured fields into the Salesforce record.`,
    exampleOutput: `<article><h2>Call — Northstar Labs — Security review approved</h2><p><strong>Outcome:</strong> Northstar approved the technical approach and will begin procurement review.</p><h3>Discussion</h3><ul><li>SSO and audit exports satisfy the security checklist.</li><li>The initial rollout covers 20 operations users.</li></ul><h3>Next steps</h3><ul><li>Send the final order form by Friday.</li><li>Schedule implementation kickoff for next week.</li></ul></article>`,
    requires: ['Salesforce'],
    trigger: { type: 'manual' },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
        {
          id: 'params',
          type: 'input',
          data: {
            label: 'Call notes',
            params: [
              { name: 'notes', type: 'string', required: true, description: 'Your raw notes from the call.' },
            ],
          },
        },
        {
          id: 'draft',
          type: 'agent',
          data: {
            label: 'Structure the notes',
            agentId: '',
            prompt:
              'Turn these call notes into a Salesforce activity log. Subject: "Call — <company or person> — <one-line outcome>", under 80 characters. Description: outcome first, then discussion points as short bullets, then explicit next steps. Keep every commitment and number from the notes; invent nothing.',
            input: 'Call notes: {{input.notes}}',
            includeUpstream: false,
            responseFormat: 'structured',
            outputFields: [
              { name: 'subject', type: 'string', description: 'Activity subject line' },
              { name: 'description', type: 'string', description: 'Activity description' },
            ],
          },
        },
        {
          id: 'create',
          type: 'tool',
          data: {
            label: 'Log in Salesforce',
            connectionId: 'nango:salesforce',
            toolName: 'salesforce_create_record',
            args: '{"sobject":"Task","fields":{"Subject":"{{step.draft.output.subject}}","Description":"{{step.draft.output.description}}","Status":"Completed"}}',
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'params' },
        { id: 'e2', source: 'params', target: 'draft' },
        { id: 'e3', source: 'draft', target: 'create' },
      ],
    },
  },
  {
    key: 'site-monitor-slack',
    name: 'Website check with Slack alert',
    description: 'Ping a URL; if it responds with an error, alert a Slack channel. Turn on a schedule to make it a monitor.',
    category: 'Monitoring',
    copilotInstructions: `Build a flow called “Website check with Slack alert.”

1. Ask for a required HTTPS URL and a Slack channel, defaulting the channel to #alerts.
2. Send a GET request to the URL with a 15-second timeout, one retry, and HTTP errors returned as data instead of stopping the flow.
3. Add a condition that checks whether the response status is below 400.
4. If healthy, stop with no notification. If unhealthy, post a Slack warning containing the URL and HTTP status.

Start as a manual flow, but make it easy to switch to a recurring schedule after creation.`,
    exampleOutput: `<article><p><strong>⚠️ Website health alert</strong></p><p><code>https://status.example.com</code> returned <strong>HTTP 503</strong>.</p><p>The check was retried once and still failed. Someone should take a look.</p></article>`,
    requires: ['Slack'],
    trigger: { type: 'manual' },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
        {
          id: 'params',
          type: 'input',
          data: {
            label: 'What to watch',
            params: [
              { name: 'url', type: 'string', required: true, description: 'The URL to check (https://…).' },
              { name: 'channel', type: 'string', required: true, default: '#alerts', description: 'Slack channel for alerts.' },
            ],
          },
        },
        {
          id: 'check',
          type: 'http',
          data: {
            label: 'Ping the site',
            method: 'GET',
            url: '{{input.url}}',
            failOnHttpError: false,
            retries: 1,
            timeoutMs: 15000,
          },
        },
        {
          id: 'healthy',
          type: 'condition',
          data: {
            label: 'Responding OK?',
            left: '{{step.check.output.status}}',
            op: 'lt',
            right: '400',
          },
        },
        {
          id: 'ok',
          type: 'stop',
          data: { label: 'All good', reason: 'Site is healthy, no alert needed.' },
        },
        {
          id: 'alert',
          type: 'tool',
          data: {
            label: 'Alert Slack',
            connectionId: 'nango:slack',
            toolName: 'slack_post_message',
            args: '{"channel":"{{input.channel}}","text":":warning: {{input.url}} returned HTTP {{step.check.output.status}}. Someone should take a look."}',
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'params' },
        { id: 'e2', source: 'params', target: 'check' },
        { id: 'e3', source: 'check', target: 'healthy' },
        { id: 'e4', source: 'healthy', target: 'ok', branch: 'true' },
        { id: 'e5', source: 'healthy', target: 'alert', branch: 'false' },
      ],
    },
  },
]
