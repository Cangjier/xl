/**
 * Output-planning tests: layout, extensions, naming, and conflicts.
 *
 * @module xl/tests/plan
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { detectConflicts, planSource } from '../src/core/plan.js'
import { parseXlMd } from '../src/core/parse.js'
import { resolveTarget, resolveTargets, typeFileBaseName, UsageError } from '../src/core/targets.js'

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

test('every target gets its own language directory under the output root', () => {
  const ts = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', naming: 'idiomatic' })
  const python = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('python', {}), { out: 'dist', naming: 'idiomatic' })
  const csharp = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('csharp', {}), { out: 'dist', naming: 'idiomatic' })
  assert.deepEqual(ts.outputs.map(output => output.path), ['dist/ts/pkg/demo.ts'])
  assert.equal(python.outputs.every(output => output.path.startsWith('dist/python/pkg/')), true)
  assert.equal(csharp.outputs.every(output => output.path.startsWith('dist/csharp/')), true)
})

test('file layout keeps the source directory under the language directory', () => {
  const plan = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', naming: 'idiomatic' })
  assert.equal(plan.layout, 'file')
  assert.deepEqual(plan.outputs.map(output => output.path), ['dist/ts/pkg/demo.ts'])
})

test('with no output root the language directory is the whole prefix', () => {
  const ts = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('ts', {}), { out: null, naming: 'idiomatic' })
  assert.deepEqual(ts.outputs.map(output => output.path), ['ts/pkg/demo.ts'])
  const python = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('python', {}), { out: null, naming: 'idiomatic' })
  assert.equal(python.outputs.every(output => output.path.startsWith('python/pkg/')), true)
})

test('--flat drops the source directory but keeps the language directory', () => {
  const plan = planSource(doc(), 'pkg/deep/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', flat: true, naming: 'idiomatic' })
  assert.deepEqual(plan.outputs.map(output => output.path), ['dist/ts/demo.ts'])
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
    out: 'dist', naming: 'idiomatic',
  })
  assert.deepEqual(plan.outputs.map(output => output.path), ['dist/python/http_client.py'])
})

test('--naming preserve keeps the declared spelling', () => {
  assert.equal(typeFileBaseName('point', 'csharp', 'idiomatic'), 'Point')
  assert.equal(typeFileBaseName('point', 'csharp', 'preserve'), 'point')
  assert.equal(typeFileBaseName('point', 'ts', 'idiomatic'), 'point')
})

test('layout is a fixed property of the target, not of an invocation', () => {
  assert.equal(resolveTarget('ts', {}).layout, 'file')
  assert.equal(resolveTarget('csharp', {}).layout, 'type')
  assert.equal(resolveTarget('java', {}).layout, 'type')
  assert.equal(resolveTarget('python', {}).layout, 'type')
  assert.equal(resolveTarget('go', {}).layout, 'type')
  assert.equal(resolveTarget('rust', {}).layout, 'type')
})

test('an unknown target is a usage error E0003', () => {
  assert.throws(() => resolveTarget('cobol', {}), (error) => error instanceof UsageError && error.code === 'E0003')
})

test('a custom target without an extension is a usage error E0004', () => {
  const config = { targets: { kotlin: {} } }
  assert.throws(() => resolveTarget('kotlin', config), (error) => error instanceof UsageError && error.code === 'E0004')
  const declared = resolveTarget('kotlin', { targets: { kotlin: { ext: 'kt' } } })
  assert.equal(declared.ext, '.kt')
  assert.equal(declared.layout, 'type')
})

test('a declared layout cannot reintroduce the file layout', () => {
  const declared = resolveTarget('kotlin', { targets: { kotlin: { ext: '.kt', layout: 'file' } } })
  assert.equal(declared.layout, 'type')
  const plan = planSource(doc(), 'pkg/demo.xl.md', declared, { out: 'dist', naming: 'idiomatic' })
  assert.deepEqual(plan.outputs.map(output => output.path), [
    'dist/kotlin/pkg/DemoModule.kt',
    'dist/kotlin/pkg/Color.kt',
    'dist/kotlin/pkg/Printable.kt',
    'dist/kotlin/pkg/Point.kt',
  ])
})

test('repeated targets are deduplicated', () => {
  assert.deepEqual(resolveTargets(['ts', 'ts', 'csharp'], {}).map(target => target.name), ['ts', 'csharp'])
})

test('two sources that plan the same path are a conflict', () => {
  const first = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', naming: 'idiomatic' })
  const second = planSource(doc(), 'pkg/demo.xl.md', resolveTarget('ts', {}), { out: 'dist', naming: 'idiomatic' })
  const conflicts = detectConflicts([first, second])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].path, 'dist/ts/pkg/demo.ts')
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
