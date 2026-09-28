/**
 * Conformance tests against the xlanguage specification.
 *
 * `tests/fixtures/demo.xl.md` and `tests/fixtures/demo.expected.ts` are
 * extracted from `docs/xl-base-case.md`, which is that specification's own
 * acceptance standard for the ts channel. The printer must reproduce the
 * expected body byte for byte.
 *
 * @module dsh-xl/tests/conformance
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { printTypeScriptBody } from '../src/core/emit-ts.js'
import { parseXlMd } from '../src/core/parse.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * Read a fixture file.
 * @param {string} name - fixture file name.
 * @returns {string} the file text.
 */
function fixture(name) {
  return readFileSync(join(fixtures, name), 'utf8').replace(/\r\n?/g, '\n')
}

test('the ts printer reproduces the base case byte for byte', () => {
  const { doc, diagnostics } = parseXlMd(fixture('demo.xl.md'), 'demo.xl.md')
  const errors = diagnostics.filter(item => item.severity === 'error')
  assert.deepEqual(errors, [], 'the base case must parse without errors')
  const produced = printTypeScriptBody(doc)
  const expected = fixture('demo.expected.ts').replace(/\n$/, '')
  assert.equal(produced, expected)
})

test('the base case body ends with exactly one newline when written as a file', () => {
  const { doc } = parseXlMd(fixture('demo.xl.md'), 'demo.xl.md')
  const body = printTypeScriptBody(doc)
  assert.ok(!body.endsWith('\n'))
})

test('the base case reports only generation-quality warnings', () => {
  const { diagnostics } = parseXlMd(fixture('demo.xl.md'), 'demo.xl.md')
  for (const item of diagnostics) {
    assert.equal(item.severity, 'warning', `${item.code} must not be an error`)
  }
})
