/**
 * Report which module emits each diagnostic code, and fail when a code in the
 * table is emitted by nothing.
 *
 * `docs/design.md` §5 states the code-to-layer mapping; this script is how that
 * statement stays true. A code with no emitter is either a documentation gap
 * or a rule that was never implemented, and both should stop the check.
 *
 *   node scripts/code-map.mjs
 *
 * @module dsh-xl/scripts/code-map
 */

import { readFileSync } from 'node:fs'
import { DIAG_CODES } from '../src/core/diagnostics.js'

/** Codes the implementation deliberately never emits, with the reason. */
const INTENTIONALLY_UNEMITTED = new Map([
  ['E4001', 'the harness-failure code; this plugin has no subprocess channel, and xl_emit reports a bad product as E4002'],
])

/**
 * Modules searched for a code, in the order the design note lists them.
 * `diagnostics.js` is excluded: it defines the codes rather than emitting them.
 */
const MODULES = [
  'scan.js',
  'targets.js',
  'source.js',
  'parse.js',
  'check.js',
  'build.js',
  'artifact.js',
]

/** @type {Map<string, Set<string>>} */
const emitters = new Map()
for (const file of MODULES) {
  const text = readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8')
  for (const match of text.matchAll(/['"]([EW]\d{4})['"]/g)) {
    if (!emitters.has(match[1])) emitters.set(match[1], new Set())
    emitters.get(match[1]).add(file)
  }
}

const defined = Object.keys(DIAG_CODES)
let problems = 0
for (const code of defined) {
  const where = emitters.get(code)
  const allowed = INTENTIONALLY_UNEMITTED.get(code)
  if (where === undefined) {
    if (allowed === undefined) problems += 1
    process.stdout.write(`${code}\t${allowed === undefined ? 'UNEMITTED' : `unemitted by design — ${allowed}`}\n`)
    continue
  }
  process.stdout.write(`${code}\t${[...where].join(', ')}\n`)
}

const undefinedCodes = [...emitters.keys()].filter(code => !defined.includes(code))
for (const code of undefinedCodes) {
  process.stdout.write(`${code}\tUSED BUT NOT IN THE TABLE\n`)
  problems += 1
}

process.stdout.write(problems === 0
  ? `code map: ok — ${defined.length} codes, ${defined.length - INTENTIONALLY_UNEMITTED.size} emitted\n`
  : `code map: ${problems} problem(s)\n`)
process.exit(problems === 0 ? 0 : 1)
