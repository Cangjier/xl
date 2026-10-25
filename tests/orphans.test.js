/**
 * Residue tests: a deleted `*.xl.md` leaves products behind, and xl has to be
 * the thing that notices.
 *
 * Every case here reproduces the same situation from a different state — the
 * product on disk, the product already gone and only the cache left, a
 * hand-written file next to the residue — because that situation is what the
 * rest of xl is structurally blind to: nothing in a run names a source that no
 * longer exists.
 *
 * @module xl/tests/orphans
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runBuild, runCheck, runOrphans } from '../src/core/build.js'
import { findOrphans, removeOrphans } from '../src/core/orphans.js'
import { dropWorkspace, makeWorkspace, read, writeFiles } from './helpers.js'

const DEMO = [
  '# method greet:(name:string)=>string',
  'greet.',
  '```ts',
  'return `hi ${name}`;',
  '```',
  '',
].join('\n')

const OTHER = [
  '# class box',
  '',
  '## field side:int = 1',
  'side.',
  '',
].join('\n')

/**
 * Build `demo.xl.md` and `other.xl.md`, then delete `demo.xl.md` — the state
 * every test in this file starts from.
 * @param {object} [files] - extra files to write before the build.
 * @returns {string} the workspace root.
 */
function workspaceWithDeletedSource(files = {}) {
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO, 'other.xl.md': OTHER, ...files })
  const built = runBuild({ cwd, paths: ['demo.xl.md', 'other.xl.md'], cli: { targets: ['ts'] }, env: {} })
  assert.equal(built.exitCode, 0)
  assert.equal(built.orphans.length, 0)
  rmSync(join(cwd, 'demo.xl.md'))
  return cwd
}

test('a deleted source leaves a product that the next build reports as E2004', () => {
  const cwd = workspaceWithDeletedSource()
  try {
    const result = runBuild({ cwd, paths: ['other.xl.md'], cli: { targets: ['ts'] }, env: {} })
    assert.equal(result.written, 0)
    assert.equal(result.skipped, 1)
    assert.equal(result.orphans.length, 1)
    const [orphan] = result.orphans
    assert.equal(orphan.out, 'dist/ts/demo.ts')
    assert.equal(orphan.source, 'demo.xl.md')
    assert.equal(orphan.target, 'ts')
    assert.equal(orphan.found, 'header')
    assert.equal(orphan.exists, true)
    const reported = result.diagnostics.filter(item => item.code === 'E2004')
    assert.equal(reported.length, 1)
    assert.equal(reported[0].severity, 'warning')
    // The diagnostic points at the product: the source is the thing that is gone.
    assert.equal(reported[0].file, 'dist/ts/demo.ts')
    assert.match(reported[0].msg, /demo\.xl\.md.*no longer exists/)
    // Only the source that was deleted is reported; the surviving one is not.
    assert.ok(!result.diagnostics.some(item => item.msg.includes('other.xl.md')))
  } finally {
    dropWorkspace(cwd)
  }
})

test('residue does not fail a build or a check, and --ignore E2004 silences it', () => {
  const cwd = workspaceWithDeletedSource()
  try {
    const built = runBuild({ cwd, paths: ['other.xl.md'], cli: { targets: ['ts'] }, env: {} })
    assert.equal(built.exitCode, 0)
    assert.equal(built.errors, 0)
    assert.equal(built.warnings, 1)

    const checked = runCheck({ cwd, paths: [], cli: {}, env: {} })
    assert.equal(checked.exitCode, 0)
    assert.equal(checked.orphans.length, 1)
    assert.deepEqual(checked.diagnostics.map(item => item.code), ['E2004'])

    const ignored = runCheck({ cwd, paths: [], cli: { ignore: ['E2004'] }, env: {} })
    assert.equal(ignored.warnings, 0)
    assert.equal(ignored.diagnostics.length, 0)

    // A strict check budget does see it, because it is a real warning.
    const strict = runCheck({ cwd, paths: [], cli: { strict: true }, env: {} })
    assert.equal(strict.exitCode, 1)
    assert.equal(strict.warnings, 1)
  } finally {
    dropWorkspace(cwd)
  }
})

test('--no-orphans turns the scan off for build and check', () => {
  const cwd = workspaceWithDeletedSource()
  try {
    const built = runBuild({ cwd, paths: ['other.xl.md'], cli: { targets: ['ts'], orphans: false }, env: {} })
    assert.deepEqual(built.orphans, [])
    assert.ok(!built.diagnostics.some(item => item.code === 'E2004'))

    const checked = runCheck({ cwd, paths: [], cli: { orphans: false }, env: {} })
    assert.deepEqual(checked.orphans, [])
    assert.equal(checked.warnings, 0)

    // The dedicated operation still sees it: only the implicit scan was waived.
    const report = runOrphans({ cwd, cli: {}, env: {} })
    assert.equal(report.orphans.length, 1)
  } finally {
    dropWorkspace(cwd)
  }
})

test('a product whose source was never deleted is not residue', () => {
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO })
  try {
    runBuild({ cwd, paths: ['demo.xl.md'], cli: { targets: ['ts'] }, env: {} })
    assert.deepEqual(findOrphans({ cwd, out: 'dist' }), [])
    const report = runOrphans({ cwd, cli: {}, env: {} })
    assert.equal(report.exitCode, 0)
    assert.deepEqual(report.orphans, [])
  } finally {
    dropWorkspace(cwd)
  }
})

test('a hand-written file in the output tree is neither reported nor removed', () => {
  const cwd = workspaceWithDeletedSource({ 'dist/ts/handwritten.ts': 'export const keep = 1\n' })
  try {
    const report = runOrphans({ cwd, cli: {}, env: {} })
    assert.deepEqual(report.orphans.map(orphan => orphan.out), ['dist/ts/demo.ts'])

    const pruned = runOrphans({ cwd, cli: { prune: true }, env: {} })
    assert.deepEqual(pruned.removed, ['dist/ts/demo.ts'])
    assert.equal(existsSync(join(cwd, 'dist', 'ts', 'handwritten.ts')), true)
    assert.equal(read(cwd, 'dist/ts/handwritten.ts'), 'export const keep = 1\n')
  } finally {
    dropWorkspace(cwd)
  }
})

test('--prune deletes exactly the residue and leaves the live product alone', () => {
  const cwd = workspaceWithDeletedSource()
  try {
    const before = runOrphans({ cwd, cli: {}, env: {} })
    assert.equal(before.exitCode, 1)
    assert.equal(before.pruned, false)
    assert.deepEqual(before.removed, [])

    const pruned = runOrphans({ cwd, cli: { prune: true }, env: {} })
    assert.equal(pruned.exitCode, 0)
    assert.equal(pruned.pruned, true)
    assert.deepEqual(pruned.removed, ['dist/ts/demo.ts'])
    assert.deepEqual(pruned.refused, [])
    assert.equal(existsSync(join(cwd, 'dist', 'ts', 'demo.ts')), false)
    assert.equal(existsSync(join(cwd, 'dist', 'ts', 'other.ts')), true)

    // Idempotent: the cache entry went with the product, so a second run is clean.
    const after = runOrphans({ cwd, cli: {}, env: {} })
    assert.equal(after.exitCode, 0)
    assert.deepEqual(after.orphans, [])
    const checked = runCheck({ cwd, paths: [], cli: {}, env: {} })
    assert.equal(checked.warnings, 0)
  } finally {
    dropWorkspace(cwd)
  }
})

test('--dry-run reports the residue without deleting it', () => {
  const cwd = workspaceWithDeletedSource()
  try {
    const dry = runOrphans({ cwd, cli: { prune: true, dryRun: true }, env: {} })
    assert.equal(dry.pruned, false)
    assert.deepEqual(dry.removed, [])
    assert.equal(existsSync(join(cwd, 'dist', 'ts', 'demo.ts')), true)
  } finally {
    dropWorkspace(cwd)
  }
})

test('a cache-only record is residue too: the product is gone but the claim is not', () => {
  const cwd = workspaceWithDeletedSource()
  try {
    rmSync(join(cwd, 'dist', 'ts', 'demo.ts'))
    const report = runOrphans({ cwd, cli: {}, env: {} })
    assert.equal(report.exitCode, 1)
    assert.equal(report.orphans.length, 1)
    const [orphan] = report.orphans
    assert.equal(orphan.out, 'dist/ts/demo.ts')
    assert.equal(orphan.source, 'demo.xl.md')
    assert.equal(orphan.found, 'cache')
    assert.equal(orphan.exists, false)

    // Nothing to delete, but the stale record has to go or the report repeats.
    const pruned = runOrphans({ cwd, cli: { prune: true }, env: {} })
    assert.deepEqual(pruned.removed, [])
    assert.deepEqual(pruned.skipped, ['dist/ts/demo.ts'])
    assert.deepEqual(pruned.dropped, ['demo.xl.md'])
    assert.deepEqual(runOrphans({ cwd, cli: {}, env: {} }).orphans, [])
  } finally {
    dropWorkspace(cwd)
  }
})

test('pruning forgets only the stale cache entry, never a live one', () => {
  const cwd = workspaceWithDeletedSource()
  try {
    runOrphans({ cwd, cli: { prune: true }, env: {} })
    const cache = JSON.parse(read(cwd, 'dist/ts/.xl/cache.json'))
    const keys = Object.keys(cache.entries)
    assert.equal(keys.length, 1)
    assert.ok(keys[0].startsWith('other.xl.md'))
  } finally {
    dropWorkspace(cwd)
  }
})

test('pruning one source leaves another deleted source in the report', () => {
  const cwd = workspaceWithDeletedSource()
  try {
    // A second source goes too, but only the first is pruned: the operation is
    // scoped to the residue it was handed, not to everything it could find.
    rmSync(join(cwd, 'other.xl.md'))
    const report = runOrphans({ cwd, cli: {}, env: {} })
    assert.deepEqual(report.orphans.map(orphan => orphan.out), ['dist/ts/demo.ts', 'dist/ts/other.ts'])

    const first = report.orphans.find(orphan => orphan.out === 'dist/ts/demo.ts')
    const pruned = removeOrphans({ cwd, out: 'dist', orphans: [first] })
    assert.deepEqual(pruned.removed, ['dist/ts/demo.ts'])
    assert.deepEqual(pruned.dropped, ['demo.xl.md'])

    const after = runOrphans({ cwd, cli: {}, env: {} })
    assert.deepEqual(after.orphans.map(orphan => orphan.out), ['dist/ts/other.ts'])
    assert.equal(existsSync(join(cwd, 'dist', 'ts', 'other.ts')), true)
  } finally {
    dropWorkspace(cwd)
  }
})

test('a restored source turns its product back into a live artifact', () => {
  const cwd = workspaceWithDeletedSource()
  try {
    assert.equal(runOrphans({ cwd, cli: {}, env: {} }).orphans.length, 1)
    writeFiles(cwd, { 'demo.xl.md': DEMO })
    assert.deepEqual(findOrphans({ cwd, out: 'dist' }), [])
    const rebuilt = runBuild({ cwd, paths: ['demo.xl.md'], cli: { targets: ['ts'] }, env: {} })
    assert.deepEqual(rebuilt.orphans, [])
  } finally {
    dropWorkspace(cwd)
  }
})

test('the output root is where residue is looked for, wherever it points', () => {
  const cwd = makeWorkspace({ 'demo.xl.md': DEMO })
  const outside = mkdtempSync(join(tmpdir(), 'xl-out-'))
  try {
    const out = join(cwd, 'build', 'gen')
    runBuild({ cwd, paths: ['demo.xl.md'], cli: { targets: ['ts'], out }, env: {} })
    rmSync(join(cwd, 'demo.xl.md'))

    // A root under the working directory is reported the way a plan names it.
    const inside = runOrphans({ cwd, cli: { out }, env: {} })
    assert.equal(inside.orphans.length, 1)
    assert.equal(inside.orphans[0].out, 'build/gen/ts/demo.ts')

    // The same workspace under a different root has nothing to report.
    const elsewhere = runOrphans({ cwd, cli: { out: 'dist2' }, env: {} })
    assert.equal(elsewhere.exitCode, 0)
    assert.deepEqual(elsewhere.orphans, [])

    // A root outside the working directory keeps its absolute path.
    const absoluteOut = join(outside, 'gen')
    writeFiles(cwd, { 'demo.xl.md': DEMO })
    runBuild({ cwd, paths: ['demo.xl.md'], cli: { targets: ['ts'], out: absoluteOut }, env: {} })
    rmSync(join(cwd, 'demo.xl.md'))
    const absolute = runOrphans({ cwd, cli: { out: absoluteOut }, env: {} })
    assert.equal(absolute.orphans.length, 1)
    assert.equal(absolute.orphans[0].out, `${absoluteOut.replace(/\\/g, '/')}/ts/demo.ts`)
  } finally {
    dropWorkspace(cwd)
    rmSync(outside, { recursive: true, force: true })
  }
})

test('residue is recognized for any language, not only the direct one', () => {
  const cwd = makeWorkspace({
    'model.xl.md': DEMO,
    // What `xl_emit` would have written for a plan-channel target whose source
    // has since been deleted. No build ever ran here.
    'dist/csharp/model/Model.cs': [
      '// @generated by xl from model.xl.md',
      '// xl:sha256:0000  xl:target:csharp  xl:ver:0.1.0  xl:prompt:abcd',
      '// DO NOT EDIT - edit the .xl.md source and regenerate',
      '',
      'namespace Demo.Generated { }',
      '',
    ].join('\n'),
  })
  try {
    rmSync(join(cwd, 'model.xl.md'))
    const report = runOrphans({ cwd, cli: {}, env: {} })
    assert.equal(report.orphans.length, 1)
    assert.equal(report.orphans[0].out, 'dist/csharp/model/Model.cs')
    assert.equal(report.orphans[0].target, 'csharp')

    const pruned = runOrphans({ cwd, cli: { prune: true }, env: {} })
    assert.deepEqual(pruned.removed, ['dist/csharp/model/Model.cs'])
    assert.equal(existsSync(join(cwd, 'dist', 'csharp', 'model', 'Model.cs')), false)
  } finally {
    dropWorkspace(cwd)
  }
})

test('the xl history archive is not residue', () => {
  const cwd = workspaceWithDeletedSource()
  try {
    // Overwrite the product once so a version lands in the archive, then delete
    // the source: the archive is xl's own history, not a stale product.
    writeFiles(cwd, { 'demo.xl.md': DEMO.replace('hi', 'hello') })
    runBuild({ cwd, paths: ['demo.xl.md'], cli: { targets: ['ts'] }, env: {} })
    assert.ok(readFileSync(join(cwd, 'dist', 'ts', '.xl', 'cache', 'demo.ts.1'), 'utf8').length > 0)
    rmSync(join(cwd, 'demo.xl.md'))

    const report = runOrphans({ cwd, cli: {}, env: {} })
    assert.deepEqual(report.orphans.map(orphan => orphan.out), ['dist/ts/demo.ts'])
    assert.ok(!report.orphans.some(orphan => orphan.out.includes('.xl/cache')))
  } finally {
    dropWorkspace(cwd)
  }
})

test('a source deleted with its product inside a source subdirectory is still found', () => {
  const cwd = makeWorkspace({ 'pkg/demo.xl.md': DEMO })
  try {
    runBuild({ cwd, paths: ['pkg/demo.xl.md'], cli: { targets: ['ts'] }, env: {} })
    rmSync(join(cwd, 'pkg', 'demo.xl.md'))
    const report = runOrphans({ cwd, cli: {}, env: {} })
    assert.equal(report.orphans.length, 1)
    assert.equal(report.orphans[0].out, 'dist/ts/pkg/demo.ts')
    assert.equal(report.orphans[0].source, 'pkg/demo.xl.md')
  } finally {
    dropWorkspace(cwd)
  }
})
