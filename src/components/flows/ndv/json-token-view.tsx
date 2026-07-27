'use client'

/**
 * Upstream data as raw JSON, where every value is a token you can click.
 *
 * Replaces the DataTree field picker: same click-to-insert contract, but the
 * user reads the actual payload rather than a summarised tree, so what they
 * map is what the step will really receive.
 *
 * Container keys are insertable too — mapping a whole object into a body field
 * is common, and forcing a leaf-by-leaf rebuild of it was busywork.
 */

const INDENT = 16

/** `{{a.b.0.c}}` — the token form every chip editor and the executor accept. */
const braced = (path: string) => `{{${path}}}`

function Token({
  path,
  children,
  onInsertToken,
}: {
  path: string
  children: React.ReactNode
  onInsertToken: (token: string) => void
}) {
  const token = braced(path)
  return (
    <span
      role="button"
      tabIndex={0}
      draggable
      data-token={token}
      title={`Insert ${token}`}
      onClick={() => onInsertToken(token)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onInsertToken(token)
        }
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', token)
        event.dataTransfer.effectAllowed = 'copy'
      }}
      className="cursor-pointer rounded px-0.5 hover:bg-indigo-100 hover:text-indigo-900 dark:hover:bg-indigo-950/60 dark:hover:text-indigo-200"
    >
      {children}
    </span>
  )
}

function Node({
  value,
  path,
  depth,
  onInsertToken,
}: {
  value: unknown
  path: string
  depth: number
  onInsertToken: (token: string) => void
}) {
  if (value !== null && typeof value === 'object') {
    const entries: Array<[string, unknown]> = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.entries(value as Record<string, unknown>)
    const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}']
    if (entries.length === 0) return <span>{open}{close}</span>
    return (
      <>
        <span>{open}</span>
        {entries.map(([key, child]) => {
          const childPath = path ? `${path}.${key}` : key
          return (
            <div key={childPath} style={{ paddingLeft: depth * INDENT }} className="whitespace-pre">
              <Token path={childPath} onInsertToken={onInsertToken}>
                {Array.isArray(value) ? key : `"${key}"`}
              </Token>
              <span>: </span>
              <Node value={child} path={childPath} depth={depth + 1} onInsertToken={onInsertToken} />
            </div>
          )
        })}
        <div style={{ paddingLeft: Math.max(0, depth - 1) * INDENT }}>{close}</div>
      </>
    )
  }

  // Leaf. The token is attached to the rendered value, so clicking what you
  // can see is what you get.
  return (
    <Token path={path} onInsertToken={onInsertToken}>
      {typeof value === 'string' ? `"${value}"` : String(value)}
    </Token>
  )
}

export function JsonTokenView({
  value,
  onInsertToken,
}: {
  value: unknown
  onInsertToken: (token: string) => void
}) {
  return (
    <div className="p-4 font-mono text-xs leading-relaxed">
      <Node value={value} path="" depth={1} onInsertToken={onInsertToken} />
    </div>
  )
}
