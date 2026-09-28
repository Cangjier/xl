/**
 * Check that the vendored xl specification still matches its upstream copy.
 *
 * `docs/xl-*.md` are verbatim copies of the specification that lives beside
 * the compiler. They are vendored so this repository is self-contained: the
 * conformance fixtures regenerate from `docs/xl-base-case.md`, and every
 * document reference in the README and the design note resolves inside this
 * checkout.
 *
 * Run it with the upstream docs directory to detect drift:
 *   node scripts/verify-docs-sync.mjs
 *   node scripts/verify-docs-sync.mjs <path-to-xlanguage>/docs
 *
 * Exit status is 0 when every file matches or the upstream directory is
 * absent (a checkout without the sibling repository is not a failure), and 1
 * when a vendored file differs from, or is missing from, the upstream copy.
 *
 * @module dsh-xl/scripts/verify-docs-sync
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Files the specification consists of. */
const VENDORED = [
  'xl-syntax.md',
  'xl-cli.md',
  'xl-check.md',
  'xl-emit-ts.md',
  'xl-base-case.md',
]

const here = dirname(fileURLToPath(import.meta.url))
const localDocs = join(here, '..', 'docs')
const upstreamDocs = resolve(process.argv[2] ?? join(here, '..', '..', 'xlanguage', 'docs'))

/**
 * SHA-256 of a file's bytes.
 * @param {string} path - file path.
 * @returns {string} lowercase hex digest.
 */
function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

if (!existsSync(upstreamDocs)) {
  process.stdout.write(`docs sync: upstream not found at ${upstreamDocs}; skipped\n`)
  process.exit(0)
}

let drifted = 0
for (const name of VENDORED) {
  const local = join(localDocs, name)
  const upstream = join(upstreamDocs, name)
  if (!existsSync(local)) {
    process.stdout.write(`${name}: MISSING locally\n`)
    drifted += 1
    continue
  }
  if (!existsSync(upstream)) {
    process.stdout.write(`${name}: not present upstream\n`)
    continue
  }
  const same = digest(local) === digest(upstream)
  process.stdout.write(`${name}: ${same ? 'in sync' : 'DRIFTED'}\n`)
  if (!same) drifted += 1
}

const extra = readdirSync(localDocs)
  .filter(name => /^xl-.*\.md$/.test(name) && !VENDORED.includes(name))
if (extra.length > 0) {
  process.stdout.write(`unexpected vendored file(s): ${extra.join(', ')}\n`)
  drifted += 1
}

process.stdout.write(drifted === 0
  ? 'docs sync: ok\n'
  : `docs sync: ${drifted} file(s) drifted; re-copy them from ${upstreamDocs}\n`)
process.exit(drifted === 0 ? 0 : 1)
