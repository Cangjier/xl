/**
 * Regenerate the conformance fixtures from the vendored xl specification.
 *
 * `tests/fixtures/demo.xl.md` and `tests/fixtures/demo.expected.ts` are copied
 * out of `docs/xl-base-case.md`, which is the acceptance standard for the ts
 * channel: the printer must reproduce the expected file byte for byte.
 *
 * The specification is vendored in this repository, so the default input is
 * `docs/xl-base-case.md`. Pass a path to read another copy instead, which is
 * how a re-sync against the upstream repository is checked:
 *   node scripts/extract-fixtures.mjs
 *   node scripts/extract-fixtures.mjs ../xlanguage/docs/xl-base-case.md
 *
 * @module xl/scripts/extract-fixtures
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(process.argv[2] ?? join(here, '..', 'docs', 'xl-base-case.md'))

const lines = readFileSync(target, 'utf8').replace(/\r\n?/g, '\n').split('\n')

/**
 * Extract the body of the nth fenced block that starts with `fence`, searching
 * from `from`. The closing fence must carry at least as many backticks as the
 * opener, so a longer fence can wrap blocks fenced with three backticks.
 * @param {string} fence - opening fence text.
 * @param {number} occurrence - 1-based occurrence index.
 * @param {number} [from] - index to start searching at.
 * @returns {string[]} the block's lines.
 */
function block(fence, occurrence, from = 0) {
  const ticks = /^`+/.exec(fence)[0]
  const closer = new RegExp(`^\\s*\`{${ticks.length},}\\s*$`)
  let seen = 0
  for (let index = from; index < lines.length; index += 1) {
    if (lines[index].trim() !== fence) continue
    seen += 1
    if (seen !== occurrence) continue
    const body = []
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (closer.test(lines[cursor])) return body
      body.push(lines[cursor])
    }
    throw new Error(`fence ${fence} #${occurrence} is unterminated`)
  }
  throw new Error(`fence ${fence} #${occurrence} not found`)
}

/** Index of the first line matching a pattern. */
function findLine(pattern) {
  const index = lines.findIndex(line => pattern.test(line))
  if (index < 0) throw new Error(`no line matches ${String(pattern)}`)
  return index
}

const input = block('````md', 1)
const expected = block('```ts', 1, findLine(/^## 输出 ts 完整代码\s*$/))
// The expected file starts with its three-line artifact header; the printer
// test compares everything after it.
const body = expected.slice(4)

const outDir = join(here, '..', 'tests', 'fixtures')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'demo.xl.md'), `${input.join('\n')}\n`, 'utf8')
writeFileSync(join(outDir, 'demo.expected.ts'), `${body.join('\n')}\n`, 'utf8')
process.stdout.write(`wrote ${input.length} input lines and ${body.length} expected body lines\n`)
