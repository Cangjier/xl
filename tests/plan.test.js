/**
 * Output-planning tests: layout, extensions, naming, and conflicts.
 *
 * @module xl/tests/plan
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { detectConflicts, planSource } from '../src/core/plan.js'
import { parseXlMd } from '../src/core/parse.js'
import { resolveLayout, resolveTarget, resolveTargets, typeFileBaseName, UsageError } from '../src/core/targets.js'

const SOURCE = [
  '# type MemberKind = "field" | "method"',
  'kinds.',
  '',
  '# const MAX_DEPTH:int = 8',
  'cap.',
  '',
  '# method loadText:(path:string)=>string',
  '```ts',
  'return path;',
  '```',
  '',
  '# enum color',
  '- case red',
  '',
  '# interface printable',
  '',
  '## field id:string',
  '',
  '# class point',
  '',
  '## field x:int = 0',
  '',
].join('\n')

/**
 * Parse the shared sample.
 * @returns {object} the parsed document.
 */
function doc() {
  const parsed = parseXlMd(SOURCE, 'pkg/demo.xl.md')
  assert.deepEqual(parsed.diagnostics.filter(item => item.severity === 'error'), [])
  return parsed.doc
}

test('file layout keeps the source directory and swaps the suffix', () => {
  const plan = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', naming: 'idiomatic' })
  assert.equal(plan.layout, 'file')
  assert.deepEqual(plan.outputs.map(output => output.path), ['dist/pkg/demo.ts'])
})

test('file layout without --out writes beside the source', () => {
  const plan = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('python', {}), { out: null, naming: 'idiomatic' })
  assert.deepEqual(plan.outputs.map(output => output.path), ['pkg/demo.py'])
})

test('--flat drops the source directory', () => {
  const plan = planSource(doc(), 'pkg/deep/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', flat: true, naming: 'idiomatic' })
  assert.deepEqual(plan.outputs.map(output => output.path), ['dist/demo.ts'])
})

test('type layout emits one file per type plus one module file', () => {
  const plan = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('csharp', {}), { out: 'dist', naming: 'idiomatic' })
  assert.equal(plan.layout, 'type')
  assert.deepEqual(plan.outputs.map(output => output.path), [
    'dist/csharp/pkg/DemoModule.cs',
    'dist/csharp/pkg/Color.cs',
    'dist/csharp/pkg/IPrintable.cs',
    'dist/csharp/pkg/Point.cs',
  ])
  const module = plan.outputs[0]
  assert.deepEqual(module.names, ['MemberKind', 'MAX_DEPTH', 'loadText'])
  assert.equal(module.kind, 'module')
})

test('python type layout uses snake_case file names', () => {
  const text = ['# class HTTPClient', '', '## field x:int = 0', ''].join('\n')
  const parsed = parseXlMd(text, 'a.xl.md')
  const plan = planSource(parsed.doc, 'a.xl.md', resolveTarget('python', {}), {
    out: 'dist', naming: 'idiomatic', layout: 'type',
  })
  assert.deepEqual(plan.outputs.map(output => output.path), ['dist/python/http_client.py'])
})

test('--naming preserve keeps the declared spelling', () => {
  assert.equal(typeFileBaseName('point', 'csharp', 'idiomatic'), 'Point')
  assert.equal(typeFileBaseName('point', 'csharp', 'preserve'), 'point')
  assert.equal(typeFileBaseName('point', 'ts', 'idiomatic'), 'point')
})

test('ts never uses the type layout', () => {
  assert.equal(resolveLayout(resolveTarget('ts', {}), 'type'), 'file')
  assert.equal(resolveLayout(resolveTarget('java', {}), 'file'), 'type')
  assert.equal(resolveLayout(resolveTarget('csharp', {}), 'file'), 'file')
})

test('an unknown target is a usage error E0003', () => {
  assert.throws(() => resolveTarget('cobol', {}), (error) => error instanceof UsageError && error.code === 'E0003')
})

test('a custom target without an extension is a usage error E0004', () => {
  const config = { targets: { kotlin: {} } }
  assert.throws(() => resolveTarget('kotlin', config), (error) => error instanceof UsageError && error.code === 'E0004')
  const declared = resolveTarget('kotlin', { targets: { kotlin: { ext: 'kt' } } })
  assert.equal(declared.ext, '.kt')
  assert.equal(declared.layout, 'file')
})

test('repeated targets are deduplicated', () => {
  assert.deepEqual(resolveTargets(['ts', 'ts', 'csharp'], {}).map(target => target.name), ['ts', 'csharp'])
})

test('two sources that plan the same path are a conflict', () => {
  const first = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', naming: 'idiomatic' })
  const second = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', naming: 'idiomatic' })
  const conflicts = detectConflicts([first, second])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].path, 'dist/pkg/demo.ts')
  assert.equal(conflicts[0].owners.length, 2)
})

test('different targets of one source do not conflict', () => {
  const ts = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', naming: 'idiomatic' })
  const cs = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('csharp', {}), { out: 'dist', naming: 'idiomatic' })
  assert.deepEqual(detectConflicts([ts, cs]), [])
})

test('flattening two same-named sources at different depths is a conflict', () => {
  const first = planSource(doc(), 'a/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', flat: true, naming: 'idiomatic' })
  const second = planSource(doc(), 'b/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', flat: true, naming: 'idiomatic' })
  assert.equal(detectConflicts([first, second]).length, 1)
})

test('a statement is labelled by position, and it alone still plans a module file', () => {
  const text = ['# statement', '```ts', 'run();', '```', ''].join('\n')
  const parsed = parseXlMd(text, 'pkg/demo.xl.md')
  assert.deepEqual(parsed.diagnostics.filter(item => item.severity === 'error'), [])
  const filePlan = planSource(parsed.doc, 'pkg/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', naming: 'idiomatic' })
  assert.deepEqual(filePlan.outputs[0].names, ['# statement 1'])
  const typePlan = planSource(parsed.doc, 'pkg/demo.xl.md', resolveTarget('csharp', {}), { out: 'dist', naming: 'idiomatic' })
  assert.deepEqual(typePlan.outputs.map(output => output.path), ['dist/csharp/pkg/DemoModule.cs'])
  assert.deepEqual(typePlan.outputs[0].names, ['# statement 1'])
  assert.equal(typePlan.outputs[0].kind, 'module')
  const two = ['# statement', '```ts', 'a();', '```', '', '# statement', '```ts', 'b();', '```', ''].join('\n')
  const both = planSource(parseXlMd(two, 'pkg/demo.xl.md').doc, 'pkg/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', naming: 'idiomatic' })
  assert.deepEqual(both.outputs[0].names, ['# statement 1', '# statement 2'])
})
