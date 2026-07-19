import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Legacy teal/orange brand colors. The landing-matched theme is grayscale +
// slate; none of these may appear in product code. Ratchet: each retheme task
// appends the paths it cleaned to CLEAN_PATHS. (#18485C is intentionally not
// listed: it is horizon-700 in the retained informational blue scale.)
const BANNED =
  /#(062F33|0B484C|FF6B35|E95725|BE3F18|FFF0E8|FFB08D|FFD6C4|E9F3F1|C8DFDB|DCE8E5|C0D5D5|B9D3D2|9DC9C2|7DACA8|315B5E)\b/gi

// Landing + auth keep their own scoped theme; never scanned.
const EXCLUDED = ['src/components/landing', 'src/app/landing.css', 'src/components/auth']

const CLEAN_PATHS = [
  'src/app/sublime-design.css',
  'src/app/globals.css',
  'tailwind.config.js',
]

function filesUnder(path: string): string[] {
  if (EXCLUDED.some((ex) => path.startsWith(ex))) return []
  if (statSync(path).isFile()) return [path]
  return readdirSync(path).flatMap((entry) => filesUnder(join(path, entry)))
}

test('no legacy brand colors in cleaned paths', () => {
  const offenders: string[] = []
  for (const file of CLEAN_PATHS.flatMap(filesUnder)) {
    if (!/\.(tsx?|css|js)$/.test(file)) continue
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.match(BANNED)) offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 120)}`)
    })
  }
  assert.deepEqual(offenders, [], `Legacy brand colors found:\n${offenders.join('\n')}`)
})
