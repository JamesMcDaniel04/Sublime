/**
 * The two built-in tools that let a run read the workspace file repository
 * directly: list_workspace_files (the roster, paged) and read_workspace_file
 * (one file, paged). Retrieval already surfaces the most similar passages
 * into the prompt; these exist for the case retrieval cannot serve —
 * "follow the playbook in onboarding.md", where the agent must read a
 * specific document end to end rather than whichever chunks scored highest.
 *
 * Read-only by construction: nothing here writes, so the tools never need
 * the approval gate, and an agent whose grant blocks the `knowledge` plane
 * is simply not offered them (execute-agent checks the grant).
 */
import type { ToolDefinition } from '@/lib/llm/model-runner'
import { wrapUntrusted } from '@/lib/llm/guardrails'
import {
  agentFileScope,
  countWorkspaceFiles,
  findWorkspaceFileByRef,
  listWorkspaceFiles,
  MAX_FILE_READ_CHARS,
  MAX_LISTED_FILES,
  pageContent,
  readWorkspaceFile,
} from './files'

export const WORKSPACE_FILES_PROVIDER = 'knowledge'
export const LIST_FILES_TOOL = 'list_workspace_files'
export const READ_FILE_TOOL = 'read_workspace_file'

export type WorkspaceFileToolset = {
  tools: ToolDefinition[]
  /** Tool name → executor, in the shape execute-agent binds. */
  execute: Record<string, (args: Record<string, unknown>) => Promise<unknown>>
  /** How many files the run can see — zero means the tools were not built. */
  fileCount: number
  /** One paragraph for the system prompt telling the model the files exist. */
  promptHint: string
}

/**
 * Build the toolset for one run. Returns an empty set when the repository
 * holds nothing this run may read, so a workspace without files never pays
 * two tool slots for it. Reads resolve against the database at call time,
 * so a file added mid-run, or one past the first page of the listing, is
 * still readable by name.
 */
export async function buildWorkspaceFileTools(params: { organizationId: string; agentId: string; userId?: string | null }): Promise<WorkspaceFileToolset> {
  const scope = agentFileScope(params)
  const fileCount = await countWorkspaceFiles(scope)
  if (!fileCount) return { tools: [], execute: {}, fileCount: 0, promptHint: '' }

  const listTool: ToolDefinition = {
    name: LIST_FILES_TOOL,
    description:
      `List the reference files your team keeps in the workspace repository (${fileCount} available): Markdown notes, playbooks, specs, and uploaded documents. Returns each file's id, title, filename, and size, newest first, ${MAX_LISTED_FILES} per page — pass the returned nextOffset to see more. Call this before read_workspace_file when you are not sure of a file's name.`,
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'number', description: `Skip this many files (for repositories with more than ${MAX_LISTED_FILES} files). Defaults to 0.` },
      },
      required: [],
    },
  }
  const readTool: ToolDefinition = {
    name: READ_FILE_TOOL,
    description:
      `Read one file from the workspace repository by id, filename, or title. Use it when the task points at a specific document (a playbook, a spec, a style guide) that you should follow in full. Long files are paged: read up to ${MAX_FILE_READ_CHARS} characters per call and pass the returned nextOffset to continue.`,
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'The file id, filename, or title (from list_workspace_files).' },
        offset: { type: 'number', description: 'Character offset to start from, for files longer than one page. Defaults to 0.' },
      },
      required: ['file'],
    },
  }

  const execute: WorkspaceFileToolset['execute'] = {
    [LIST_FILES_TOOL]: async (args) => {
      const offset = Math.max(0, Math.trunc(Number(args.offset ?? 0)) || 0)
      const [files, total] = await Promise.all([listWorkspaceFiles(scope, { offset }), countWorkspaceFiles(scope)])
      const nextOffset = offset + files.length < total ? offset + files.length : null
      return {
        files: files.map((file) => ({
          id: file.id, title: file.title, filename: file.filename, chars: file.charCount,
          updatedAt: file.updatedAt.toISOString(),
        })),
        offset,
        total,
        nextOffset,
      }
    },
    [READ_FILE_TOOL]: async (args) => {
      const ref = String(args.file ?? '').trim()
      if (!ref) return { error: 'Provide the file id, filename, or title to read.' }
      const { file, candidates } = await findWorkspaceFileByRef(scope, ref)
      if (!file) {
        return candidates.length
          ? { error: `"${ref}" matches several files; use one id: ${candidates.map((c) => `${c.id} (${c.filename})`).join(', ')}` }
          : { error: `No workspace file matches "${ref}". Call list_workspace_files to see what is available.` }
      }
      const doc = await readWorkspaceFile(scope, file.id)
      if (!doc) return { error: `"${file.filename}" is no longer available.` }
      const page = pageContent(doc.content, Number(args.offset ?? 0))
      return {
        id: doc.id,
        title: doc.title,
        filename: doc.filename,
        offset: page.offset,
        totalChars: page.totalChars,
        truncated: page.truncated,
        nextOffset: page.nextOffset,
        // A file is reference material a colleague wrote, never an instruction
        // channel — the same fence retrieved passages get.
        content: wrapUntrusted(page.content, 'a workspace file'),
      }
    },
  }

  const promptHint = [
    '## Workspace files',
    `Your team keeps ${fileCount} reference file${fileCount === 1 ? '' : 's'} in the workspace repository (notes, playbooks, specs, uploaded documents). ` +
      `When a task refers to a document by name, or a playbook should be followed in full, call ${LIST_FILES_TOOL} to find it and ${READ_FILE_TOOL} to read it rather than relying on the retrieved excerpts alone.`,
  ].join('\n')

  return { tools: [listTool, readTool], execute, fileCount, promptHint }
}
