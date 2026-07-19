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
    description: 'Paste a raw bug report and get a well-structured GitHub issue — clear title, repro steps, and expected behavior.',
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
              'Turn this bug report into a well-formed GitHub issue. Title: imperative, specific, under 70 characters. Body: markdown with sections for Summary, Steps to reproduce (numbered, inferred where reasonable), Expected behavior, and Actual behavior. Do not invent details you cannot infer — mark unknowns as "Needs info".',
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
    description: 'Paste raw call notes and log a tidy activity in Salesforce — subject and summary written for you.',
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
          data: { label: 'All good', reason: 'Site is healthy — no alert needed.' },
        },
        {
          id: 'alert',
          type: 'tool',
          data: {
            label: 'Alert Slack',
            connectionId: 'nango:slack',
            toolName: 'slack_post_message',
            args: '{"channel":"{{input.channel}}","text":":warning: {{input.url}} returned HTTP {{step.check.output.status}} — someone should take a look."}',
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
