/**
 * The Code node's default snippets — n8n's starters, adapted to Sublime's
 * data model: items here are the raw upstream values, not n8n's
 * `{ json: ... }` envelopes, so the snippets write fields directly.
 *
 * Shared by the node factory (a fresh node starts with a snippet) and the
 * editor (switching language/mode swaps ONLY while the code is still one of
 * these — a user's edit is never clobbered, which is why `isDefaultSnippet`
 * checks membership across all four).
 */
export type CodeLanguage = 'javascript' | 'python'
export type CodeMode = 'allItems' | 'eachItem'

export const CODE_SNIPPETS: Record<CodeLanguage, Record<CodeMode, string>> = {
  javascript: {
    allItems:
      "// Loop over input items and add a new field called 'myNewField' to each one\n"
      + 'for (const item of $input.all()) {\n'
      + '  item.myNewField = 1;\n'
      + '}\n'
      + '\n'
      + 'return $input.all();',
    eachItem:
      "// Add a new field called 'myNewField' to the item\n"
      + '$input.item.myNewField = 1;\n'
      + '\n'
      + 'return $input.item;',
  },
  python: {
    allItems:
      "# Loop over input items and add a new field called 'my_new_field' to each one\n"
      + 'for item in _items:\n'
      + '    item["my_new_field"] = 1\n'
      + 'return _items',
    eachItem:
      "# Add a new field called 'my_new_field' to the item\n"
      + '_item["my_new_field"] = 1\n'
      + 'return _item',
  },
}

export function isDefaultSnippet(code: string): boolean {
  const trimmed = code.trim()
  if (!trimmed) return true
  return Object.values(CODE_SNIPPETS).some((byMode) => Object.values(byMode).some((snippet) => snippet.trim() === trimmed))
}
