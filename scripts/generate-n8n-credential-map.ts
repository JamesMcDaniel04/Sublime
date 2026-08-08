/**
 * Regenerates src/lib/import/n8n-credential-map.json from n8n's published
 * credential definitions. Run manually, never in the build:
 *
 *   npm install --prefix /tmp/n8n-truth n8n-nodes-base n8n-core qs --no-save
 *   npx tsx scripts/generate-n8n-credential-map.ts /tmp/n8n-truth
 *
 * Output is factual data only (auth mechanism + header/query/display names);
 * no n8n source is copied. Sorted by key for stable diffs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { classifyN8nCredential, type N8nCredentialMapEntry } from '../src/lib/import/n8n-credential-classify'

const installDir = process.argv[2]
if (!installDir) {
  console.error('Usage: tsx scripts/generate-n8n-credential-map.ts <dir containing node_modules/n8n-nodes-base>')
  process.exit(1)
}
const req = createRequire(path.join(path.resolve(installDir), 'noop.js'))
const basePath = path.dirname(req.resolve('n8n-nodes-base/package.json'))
const manifest = req('n8n-nodes-base/package.json') as { n8n: { credentials: string[] } }

const table: Record<string, N8nCredentialMapEntry> = {}
const histogram: Record<string, number> = {}
const failures: string[] = []

for (const credPath of manifest.n8n.credentials) {
  try {
    const mod = req(path.join(basePath, credPath))
    const Cls = mod[Object.keys(mod)[0]]
    const inst = new Cls()
    const entry = classifyN8nCredential({
      name: inst.name,
      displayName: inst.displayName,
      extends: inst.extends,
      authenticate: inst.authenticate,
    })
    table[String(inst.name).toLowerCase()] = entry
    histogram[entry.type] = (histogram[entry.type] ?? 0) + 1
  } catch (error) {
    failures.push(`${credPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const size = Object.keys(table).length
if (size < 300) {
  console.error(`Refusing to write a gutted table (${size} entries). Failures:\n${failures.join('\n')}`)
  process.exit(1)
}
const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)))
const outPath = path.join(__dirname, '..', 'src', 'lib', 'import', 'n8n-credential-map.json')
fs.writeFileSync(outPath, `${JSON.stringify(sorted, null, 1)}\n`)
console.log(`Wrote ${size} entries to ${outPath}`)
console.log('Classification histogram:', histogram)
if (failures.length) console.log(`Skipped ${failures.length} definitions:\n${failures.join('\n')}`)
