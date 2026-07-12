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
  salesforce: {
    klavisName: 'Salesforce',
    description: 'Query and update Salesforce CRM accounts and opportunities',
    tools: [
      { name: 'query', description: 'Run a SOQL query over CRM records' },
      { name: 'get_record', description: 'Read a record by object type and id' },
      { name: 'create_record', description: 'Create a record (account, contact, opportunity…)' },
      { name: 'update_record', description: 'Update fields on an existing record' },
    ],
  },
  confluence: {
    klavisName: 'Confluence',
    description: 'Read and write Confluence pages and spaces',
    tools: [
      { name: 'search', description: 'Search pages and spaces by keyword or CQL' },
      { name: 'read_page', description: 'Read the content of a page' },
      { name: 'create_page', description: 'Create a page in a space' },
      { name: 'update_page', description: 'Update or append to a page’s content' },
    ],
  },
  google_calendar: {
    klavisName: 'Google Calendar',
    description: 'Read and manage Google Calendar events',
    tools: [
      { name: 'list_events', description: 'List upcoming or past events on a calendar' },
      { name: 'create_event', description: 'Create a new calendar event' },
      { name: 'update_event', description: 'Update the time, attendees, or details of an event' },
    ],
  },
  google_docs: {
    klavisName: 'Google Docs',
    description: 'Read and write Google Docs documents',
    tools: [
      { name: 'create_document', description: 'Create a new document' },
      { name: 'read_document', description: 'Read the content of a document' },
      { name: 'update_document', description: 'Update the content of a document' },
    ],
  },
  google_forms: {
    klavisName: 'Google Forms',
    description: 'Create Google Forms and read their responses',
    tools: [
      { name: 'create_form', description: 'Create a new form' },
      { name: 'list_responses', description: 'List responses submitted to a form' },
      { name: 'get_form', description: 'Read a form’s structure and questions' },
    ],
  },
  google_cloud: {
    klavisName: 'Google Cloud',
    description: 'Inspect Google Cloud projects, resources, and logs',
    tools: [
      { name: 'list_projects', description: 'List accessible Google Cloud projects' },
      { name: 'list_resources', description: 'List resources within a project' },
      { name: 'get_logs', description: 'Read logs for a project or resource' },
    ],
  },
  clickup: {
    klavisName: 'ClickUp',
    description: 'Manage ClickUp tasks and lists',
    tools: [
      { name: 'list_tasks', description: 'List tasks in a list or space' },
      { name: 'create_task', description: 'Create a task with name and details' },
      { name: 'update_task', description: 'Update a task’s fields or status' },
    ],
  },
  supabase: {
    klavisName: 'Supabase',
    description: 'Query and manage Supabase Postgres databases',
    tools: [
      { name: 'run_sql', description: 'Run a SQL query against the database' },
      { name: 'list_tables', description: 'List tables in the database' },
      { name: 'insert_row', description: 'Insert a row into a table' },
    ],
  },
  airtable: {
    klavisName: 'Airtable',
    description: 'Read and write Airtable bases',
    tools: [
      { name: 'list_records', description: 'List records in a table or view' },
      { name: 'create_record', description: 'Create a record with field values' },
      { name: 'update_record', description: 'Update fields on an existing record' },
    ],
  },
  intercom: {
    klavisName: 'Intercom',
    description: 'Manage Intercom conversations and contacts',
    tools: [
      { name: 'list_conversations', description: 'List and filter support conversations' },
      { name: 'reply_conversation', description: 'Reply to an existing conversation' },
      { name: 'create_contact', description: 'Create a contact record' },
    ],
  },
  snowflake: {
    klavisName: 'Snowflake',
    description: 'Query and inspect Snowflake data warehouses',
    tools: [
      { name: 'run_query', description: 'Run a SQL query against the warehouse' },
      { name: 'list_tables', description: 'List tables in a schema' },
      { name: 'describe_table', description: 'Describe a table’s columns and types' },
    ],
  },
  figma: {
    klavisName: 'Figma',
    description: 'Read Figma files and export frames',
    tools: [
      { name: 'list_files', description: 'List files in a project or team' },
      { name: 'get_file', description: 'Read a file’s structure and contents' },
      { name: 'export_frames', description: 'Export frames or nodes as images' },
    ],
  },
  plai: {
    klavisName: 'Plai',
    description: 'Create and manage AI-powered advertising campaigns',
    tools: [
      { name: 'list_campaigns', description: 'List advertising campaigns and their status' },
      { name: 'get_campaign', description: 'Read campaign settings and performance' },
      { name: 'create_campaign', description: 'Create an advertising campaign' },
    ],
  },
  posthog: {
    klavisName: 'PostHog',
    description: 'Query product analytics, events, insights, and feature flags',
    tools: [
      { name: 'query_events', description: 'Query captured product events' },
      { name: 'list_insights', description: 'List saved analytics insights' },
      { name: 'list_feature_flags', description: 'List feature flags and their status' },
    ],
  },
  postman: {
    klavisName: 'Postman',
    description: 'Manage Postman workspaces, collections, and API requests',
    tools: [
      { name: 'list_collections', description: 'List API collections in a workspace' },
      { name: 'get_collection', description: 'Read a collection and its requests' },
      { name: 'run_collection', description: 'Run requests from a collection' },
    ],
  },
  youtube: {
    klavisName: 'YouTube',
    description: 'Search and manage YouTube videos, channels, and playlists',
    tools: [
      { name: 'search_videos', description: 'Search for videos and channels' },
      { name: 'get_video', description: 'Read video details and statistics' },
      { name: 'list_playlist_items', description: 'List videos in a playlist' },
    ],
  },
  close: {
    klavisName: 'Close',
    description: 'Manage Close CRM leads, contacts, opportunities, and activities',
    tools: [
      { name: 'list_leads', description: 'Search and list CRM leads' },
      { name: 'create_lead', description: 'Create a lead and its contacts' },
      { name: 'update_opportunity', description: 'Update an opportunity or pipeline status' },
    ],
  },
  gitlab: {
    klavisName: 'GitLab',
    description: 'Manage GitLab projects, merge requests, issues, and pipelines',
    tools: [
      { name: 'list_projects', description: 'List accessible GitLab projects' },
      { name: 'list_merge_requests', description: 'List and read merge requests' },
      { name: 'create_issue', description: 'Create an issue in a project' },
      { name: 'get_pipeline', description: 'Read pipeline status and jobs' },
    ],
  },
  motion: {
    klavisName: 'Motion',
    description: 'Manage Motion projects, tasks, schedules, and workspaces',
    tools: [
      { name: 'list_tasks', description: 'List tasks in a workspace or project' },
      { name: 'create_task', description: 'Create and schedule a task' },
      { name: 'update_task', description: 'Update task details or completion state' },
    ],
  },
  microsoft_teams: {
    klavisName: 'Microsoft Teams',
    description: 'Collaborate through Microsoft Teams chats, channels, meetings, and messages',
    tools: [
      { name: 'list_teams', description: 'List teams and channels available to the account' },
      { name: 'list_messages', description: 'Read recent channel or chat messages' },
      { name: 'send_message', description: 'Send a message to a channel or chat' },
      { name: 'list_meetings', description: 'List scheduled Teams meetings' },
    ],
  },
  hugging_face: {
    klavisName: 'Hugging Face',
    description: 'Discover and work with Hugging Face models, datasets, and Spaces',
    tools: [
      { name: 'search_models', description: 'Search models on the Hugging Face Hub' },
      { name: 'get_model', description: 'Read model metadata and documentation' },
      { name: 'search_datasets', description: 'Search datasets available on the Hub' },
      { name: 'run_inference', description: 'Run inference with a hosted model' },
    ],
  },
  amplitude: {
    klavisName: 'Amplitude',
    description: 'Query Amplitude product analytics, cohorts, events, and dashboards',
    tools: [
      { name: 'query_events', description: 'Query product events and user activity' },
      { name: 'list_charts', description: 'List saved charts and dashboards' },
      { name: 'get_cohort', description: 'Read a behavioral cohort and its members' },
      { name: 'get_metrics', description: 'Retrieve product analytics metrics' },
    ],
  },
  // NOTE: Every provider above is authorized at the Klavis account level.
  // Providers with no per-user OAuth flow (oauthUrl: null — e.g. Snowflake's
  // account credentials, Intercom's Strata routing) are still included here so
  // the capability card renders; their `connectionStatus` resolves via the
  // account-level authNeeded === false path instead of a per-user OAuth redirect.
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
