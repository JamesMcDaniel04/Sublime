// Curated set of Klavis-backed MCP providers. The `klavisName` MUST match
// Klavis's serverName enum exactly (verified against the live API), or
// instance creation returns a 422.
//
// `tools` is the source of truth for what each provider can do — name + a short,
// plain-language description shown on the capability cards. `verbs` (tool names
// only) is derived from it for the Klavis instance configuration payload.

export type ProviderTool = { name: string; description: string }

type RawCapability = {
  klavisName: string
  description: string
  tools: ProviderTool[]
}

const RAW = {
  github: {
    klavisName: 'GitHub',
    description: 'Manage GitHub repositories, pull requests, and issues',
    tools: [
      { name: 'list_repositories', description: 'List repositories for a user or organization' },
      { name: 'list_pull_requests', description: 'List and read pull requests on a repository' },
      { name: 'create_issue', description: 'Open a new issue with a title and body' },
      { name: 'comment', description: 'Add a comment to an issue or pull request' },
    ],
  },
  slack: {
    klavisName: 'Slack',
    description: 'Read and send Slack messages',
    tools: [
      { name: 'list_channels', description: 'List channels the bot can access' },
      { name: 'read_messages', description: 'Read recent messages from a channel' },
      { name: 'send_message', description: 'Post a message to a channel or thread' },
    ],
  },
  linear: {
    klavisName: 'Linear',
    description: 'Manage Linear issues and projects',
    tools: [
      { name: 'list_issues', description: 'Search and list issues across teams' },
      { name: 'create_issue', description: 'Create an issue with title, description, and assignee' },
      { name: 'update_issue', description: 'Change an issue’s status, assignee, or fields' },
    ],
  },
  asana: {
    klavisName: 'Asana',
    description: 'Manage Asana projects and tasks',
    tools: [
      { name: 'list_tasks', description: 'List tasks in a project or assigned to a user' },
      { name: 'create_task', description: 'Create a task with name, notes, and due date' },
      { name: 'update_task', description: 'Update a task’s fields or completion state' },
    ],
  },
  jira: {
    klavisName: 'Jira',
    description: 'Manage Jira projects and issues',
    tools: [
      { name: 'list_issues', description: 'Search issues with JQL or by project' },
      { name: 'create_issue', description: 'Create an issue in a project' },
      { name: 'update_issue', description: 'Transition or edit an existing issue' },
    ],
  },
  monday: {
    klavisName: 'Monday',
    description: 'Manage Monday.com boards and items',
    tools: [
      { name: 'list_boards', description: 'List boards and their columns' },
      { name: 'create_item', description: 'Add an item to a board' },
      { name: 'update_item', description: 'Update column values on an item' },
    ],
  },
  zendesk: {
    klavisName: 'Zendesk',
    description: 'Manage Zendesk support tickets',
    tools: [
      { name: 'list_tickets', description: 'List and filter support tickets' },
      { name: 'create_ticket', description: 'Open a ticket on behalf of a requester' },
      { name: 'update_ticket', description: 'Update status, priority, or add a comment' },
    ],
  },
  notion: {
    klavisName: 'Notion',
    description: 'Read and update Notion pages and databases',
    tools: [
      { name: 'search', description: 'Search pages and databases by keyword' },
      { name: 'read_page', description: 'Read the content of a page' },
      { name: 'create_page', description: 'Create a page in a workspace or database' },
      { name: 'update_page', description: 'Append to or update a page’s content' },
    ],
  },
  gmail: {
    klavisName: 'Gmail',
    description: 'Read, draft, and send Gmail messages',
    tools: [
      { name: 'list_messages', description: 'Search and list messages in the mailbox' },
      { name: 'read_message', description: 'Read the full content of a message' },
      { name: 'send_message', description: 'Send an email to one or more recipients' },
      { name: 'create_draft', description: 'Save a draft without sending it' },
    ],
  },
  google_drive: {
    klavisName: 'Google Drive',
    description: 'Browse and read Google Drive files',
    tools: [
      { name: 'list_files', description: 'List files and folders' },
      { name: 'read_file', description: 'Read the contents of a file' },
      { name: 'search', description: 'Search files by name or content' },
    ],
  },
  google_sheets: {
    klavisName: 'Google Sheets',
    description: 'Read and write Google Sheets',
    tools: [
      { name: 'read_range', description: 'Read values from a cell range' },
      { name: 'append_row', description: 'Append a row of values to a sheet' },
      { name: 'update_range', description: 'Write values into a cell range' },
    ],
  },
  hubspot: {
    klavisName: 'HubSpot',
    description: 'Manage HubSpot CRM contacts and deals',
    tools: [
      { name: 'list_contacts', description: 'List and search CRM contacts' },
      { name: 'create_contact', description: 'Create a contact record' },
      { name: 'list_deals', description: 'List and filter deals in the pipeline' },
      { name: 'update_deal', description: 'Update a deal’s stage or properties' },
    ],
  },
  // NOTE: Intercom and Snowflake are deliberately NOT in this per-provider
  // catalog. Klavis exposes no per-user auth flow for them (oauthUrl: null —
  // Snowflake uses account credentials, Intercom routes through Strata), so a
  // per-provider instance can never finish connecting here. They're served via
  // the org's Klavis Strata connection instead (see /api/mcp/strata-catalog).
} satisfies Record<string, RawCapability>

// Derive the display+config shape: keep `tools` (name + description) and add
// `verbs` (names only) for the Klavis instance configuration payload.
export const PROVIDER_CAPABILITIES = Object.fromEntries(
  Object.entries(RAW).map(([provider, capability]) => [
    provider,
    { ...capability, verbs: capability.tools.map((tool) => tool.name) },
  ]),
) as { [K in keyof typeof RAW]: (typeof RAW)[K] & { verbs: string[] } }

export type MCPProvider = keyof typeof RAW

export const PROVIDERS = Object.keys(RAW) as MCPProvider[]

export function klavisServerName(provider: string): string | null {
  const entry = (PROVIDER_CAPABILITIES as Record<string, { klavisName: string }>)[provider.toLowerCase()]
  return entry ? entry.klavisName : null
}
