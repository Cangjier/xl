/**
 * Checker tests: the rules that need the whole document or the dependency
 * index, and the generation-quality warnings that depend on target languages.
 *
 * @module xl/tests/check
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { checkWorkspace, prepareWorkspace } from '../src/core/build.js'
import { resolveTarget } from '../src/core/targets.js'
import { dropWorkspace, makeWorkspace } from './helpers.js'

/**
 * Prepare and check a workspace.
 * @param {Record<string, string>} files - workspace files.
 * @param {readonly string[]} [targets] - requested target names.
 * @returns {{diagnostics: object[], root: string}} the diagnostics and the workspace root.
 */
function check(files, targets = ['ts']) {
  const cwd = makeWorkspace(files)
  const prepared = prepareWorkspace({ cwd, paths: ['.'] })
  const diagnostics = checkWorkspace(prepared, { targets: targets.map(name => resolveTarget(name, {})) })
  return { diagnostics, root: cwd }
}

/**
 * Codes of the diagnostics for a workspace.
 * @param {Record<string, string>} files - workspace files.
 * @param {readonly string[]} [targets] - requested target names.
 * @returns {string[]} sorted code list.
 */
function codes(files, targets) {
  const { diagnostics, root } = check(files, targets)
  try {
    return diagnostics.map(item => item.code).sort()
  } finally {
    dropWorkspace(root)
  }
}

test('an unresolved extends target is E1104', () => {
  const source = ['# class box extends pointt', ''].join('\n')
  assert.deepEqual(codes({ 'a.xl.md': source }), ['E1104'])
})

test('a resolved local extends target is accepted', () => {
  const source = ['# class point', '', '# class box extends point', ''].join('\n')
  assert.deepEqual(codes({ 'a.xl.md': source }), [])
})

test('a built-in extends target is accepted', () => {
  const source = ['# class box extends Map', ''].join('\n')
  assert.deepEqual(codes({ 'a.xl.md': source }), [])
})

test('an imported extends target is resolved through the dependency index', () => {
  const base = ['# class point', ''].join('\n')
  const derived = [
    '# dependencies',
    '```xl',
    'import { point } from "./base.xl.md"',
    '```',
    '',
    '# class box extends point',
    '',
  ].join('\n')
  assert.deepEqual(codes({ 'base.xl.md': base, 'derived.xl.md': derived }), [])
})

test('implements of a class is E1105', () => {
  const source = ['# class marker', '', '# class box implements marker', ''].join('\n')
  assert.deepEqual(codes({ 'a.xl.md': source }), ['E1105'])
})

test('a class missing an interface member is E1105', () => {
  const source = [
    '# interface printable',
    '',
    '## method print:()=>string',
    '',
    '# class box implements printable',
    '',
  ].join('\n')
  assert.ok(codes({ 'a.xl.md': source }).includes('E1105'))
})

test('a fully implemented interface is accepted', () => {
  const source = [
    '# interface printable',
    '',
    '## method print:()=>string',
    '',
    '# class box implements printable',
    '',
    '## method print:()=>string',
    'print.',
    '```ts',
    'return "box";',
    '```',
    '',
  ].join('\n')
  assert.equal(codes({ 'a.xl.md': source }).includes('E1105'), false)
})

test('an optional interface member imposes no obligation', () => {
  const source = [
    '# interface printable',
    '',
    '## field note?:string',
    '',
    '# class box implements printable',
    '',
  ].join('\n')
  assert.equal(codes({ 'a.xl.md': source }).includes('E1105'), false)
})

test('an implemented member with the wrong parameter count is E1105', () => {
  const source = [
    '# interface printable',
    '',
    '## method print:(verbose:bool)=>string',
    '',
    '# class box implements printable',
    '',
    '## method print:()=>string',
    'print.',
    '```ts',
    'return "box";',
    '```',
    '',
  ].join('\n')
  assert.ok(codes({ 'a.xl.md': source }).includes('E1105'))
})

test('a cross-file duplicate type is E1107', () => {
  const source = ['# class point', ''].join('\n')
  assert.deepEqual(codes({ 'a.xl.md': source, 'b.xl.md': source }), ['E1107'])
})

test('W3010 fires for a member with no ts body and no target hint', () => {
  const source = ['# method tick:()=>int', 'tick.', ''].join('\n')
  assert.ok(codes({ 'a.xl.md': source }, ['csharp']).includes('W3010'))
})

test('W3010 does not fire for the ts target', () => {
  const source = ['# method tick:()=>int', 'tick.', ''].join('\n')
  assert.deepEqual(codes({ 'a.xl.md': source }, ['ts']), [])
})

test('W3010 does not fire when the target language has an override section', () => {
  const source = [
    '# method tick:()=>int',
    'tick.',
    '',
    '## csharp',
    '```csharp',
    'public static int Tick() => 1;',
    '```',
    '',
  ].join('\n')
  assert.deepEqual(codes({ 'a.xl.md': source }, ['csharp']), [])
})

test('W3101 fires when an override cites a ts dependency with no dependency note', () => {
  const source = [
    '# dependencies',
    '```ts',
    'import { readFileSync as rf } from "node:fs";',
    '```',
    '',
    '# method loadText:(path:string)=>string',
    'load.',
    '```ts',
    'return rf(path, "utf8");',
    '```',
    '',
    '## csharp',
    '```csharp',
    '// rf is File.ReadAllText',
    '```',
    '',
  ].join('\n')
  assert.deepEqual(codes({ 'a.xl.md': source }, ['csharp']), ['W3101'])
})

test('W3101 is suppressed by a matching dependency note', () => {
  const source = [
    '# dependencies',
    '```ts',
    'import { readFileSync as rf } from "node:fs";',
    '```',
    '',
    '## csharp',
    '```csharp',
    '// rf maps to File.ReadAllText',
    '```',
    '',
    '# method loadText:(path:string)=>string',
    'load.',
    '```ts',
    'return rf(path, "utf8");',
    '```',
    '',
    '## csharp',
    '```csharp',
    'return File.ReadAllText(path);',
    '```',
    '',
  ].join('\n')
  assert.equal(codes({ 'a.xl.md': source }, ['csharp']).includes('W3101'), false)
})

test('W3102 fires for a member without prose', () => {
  const source = ['# class point', '', '## field x:int = 0', ''].join('\n')
  assert.deepEqual(codes({ 'a.xl.md': source }), ['W3102'])
})

test('W3103 fires for a namespace without a description', () => {
  const source = ['# namespace demo', ''].join('\n')
  assert.deepEqual(codes({ 'a.xl.md': source }), ['W3103'])
})

test('W3104 fires for a requested target with no override section', () => {
  const source = ['# class point', ''].join('\n')
  assert.deepEqual(codes({ 'a.xl.md': source }, ['csharp']), ['W3104'])
})

test('W3104 is suppressed by an override section anywhere in the file', () => {
  const source = [
    '# class point',
    '',
    '## field x:int = 0',
    'x.',
    '',
    '### csharp',
    '```csharp',
    'public int X;',
    '```',
    '',
  ].join('\n')
  assert.deepEqual(codes({ 'a.xl.md': source }, ['csharp']), [])
})

test('W3011 and W3012 report empty language sections and empty blocks', () => {
  const emptySection = [
    '# enum color',
    '- case red',
    '',
    '## python',
    'just prose',
    '',
  ].join('\n')
  assert.ok(codes({ 'a.xl.md': emptySection }).includes('W3011'))
  const emptyBlock = [
    '# method tick:()=>int',
    'tick.',
    '',
    '```ts',
    '```',
    '',
  ].join('\n')
  assert.ok(codes({ 'a.xl.md': emptyBlock }).includes('W3012'))
})

test('an ignored code is removed from the result', () => {
  const cwd = makeWorkspace({ 'a.xl.md': ['# class point', '', '## field x:int = 0', ''].join('\n') })
  try {
    const prepared = prepareWorkspace({ cwd, paths: ['.'] })
    const diagnostics = checkWorkspace(prepared, {
      targets: [resolveTarget('ts', {})],
      ignore: new Set(['W3102']),
    })
    assert.deepEqual(diagnostics, [])
  } finally {
    dropWorkspace(cwd)
  }
})

test('W3010 covers a # statement with no ts body', () => {
  const source = [
    '# statement',
    '## csharp',
    '```csharp',
    'Main(args);',
    '```',
    '',
  ].join('\n')
  // `ts` is reported too: without a ts body the whole section is missing from
  // the ts artifact, which no member-level warning would catch.
  assert.deepEqual(codes({ 'a.xl.md': source }), ['W3010'])
  assert.deepEqual(codes({ 'a.xl.md': source }, ['csharp']), [])
})

test('a # statement with a ts body needs no per-target hint', () => {
  const source = ['# statement', '```ts', 'Main([]);', '```', ''].join('\n')
  // The ts body is the generation basis for every target, so no W3010 here;
  // W3104 (a target with no override section) is a different rule.
  assert.ok(!codes({ 'a.xl.md': source }, ['csharp']).includes('W3010'))
})
