import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Retired pre-goal-repositioning copy. The 2026-07-26 goal-based
// repositioning swept these phrases out of product copy, README, and the
// Supabase docs in favor of goal-anchored language ("the goal-based AI
// platform", "deploys specialized agents against it", etc). Ratchet: any
// future PR that reintroduces the old framing fails here.
//
// docs/superpowers is intentionally excluded — the spec and implementation
// plan there legitimately quote the old copy as "before" text.
const BANNED = [
  'AI that knows your business',
  'knows your business',
  'AI-agent workspace',
  'delivers useful outcomes',
  'deliver useful outcomes',
]

const CLEAN_PATHS = ['src', 'README.md', 'docs/supabase']

// This file necessarily quotes the banned phrases (to define them) — exclude
// it from its own scan.
const SELF = 'src/lib/__tests__/no-retired-brand-copy.test.ts'

function filesUnder(path: string): string[] {
  if (statSync(path).isFile()) return [path]
  return readdirSync(path).flatMap((entry) => filesUnder(join(path, entry)))
}

test('no retired pre-repositioning brand copy in cleaned paths', () => {
  const offenders: string[] = []
  for (const file of CLEAN_PATHS.flatMap(filesUnder)) {
    if (file === SELF) continue
    if (!/\.(tsx?|mdx?|css|js|html)$/.test(file)) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const phrase of BANNED) {
        if (line.toLowerCase().includes(phrase.toLowerCase())) {
          offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 120)}`)
        }
      }
    })
  }
  assert.deepEqual(offenders, [], `Retired brand copy found:\n${offenders.join('\n')}`)
})
