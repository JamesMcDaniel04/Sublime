import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

const manifestPath = path.join(process.cwd(), '.next', 'app-build-manifest.json')
if (!fs.existsSync(manifestPath)) {
  throw new Error('Bundle budget requires a completed Next.js build.')
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const budgets = {
  '/(app)/g/[scope]/flows/[id]/page': 400_000,
  '/(app)/g/[scope]/goals/page': 300_000,
  '/(app)/g/[scope]/agents/page': 290_000,
}

let failed = false
for (const [route, limit] of Object.entries(budgets)) {
  const files = manifest.pages?.[route]
  if (!Array.isArray(files)) {
    console.error(`bundle budget: route missing from manifest: ${route}`)
    failed = true
    continue
  }
  const bytes = files.reduce((total, file) => {
    const absolute = path.join(process.cwd(), '.next', file)
    return total + gzipSync(fs.readFileSync(absolute)).byteLength
  }, 0)
  console.log(`bundle budget: ${route} ${(bytes / 1000).toFixed(1)}k / ${(limit / 1000).toFixed(0)}k gzip`)
  if (bytes > limit) failed = true
}
if (failed) process.exitCode = 1
