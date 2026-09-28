/**
 * Parser tests: IR construction and the syntax / structure diagnostics.
 *
 * @module dsh-xl/tests/parse
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseXlMd } from '../src/core/parse.js'

/**
 * Parse a source and return its diagnostics.
 * @param {string} text - source text.
 * @returns {object[]} diagnostics.
 */
function diagnosticsOf(text) {
  return parseXlMd(text, 'x.xl.md').diagnostics
}

/**
 * Error codes reported for a source. Generation-quality warnings are excluded
 * so a structural assertion is not disturbed by them.
 * @param {string} text - source text.
 * @returns {string[]} sorted error code list.
 */
function codes(text) {
  return diagnosticsOf(text)
    .filter(item => item.severity === 'error')
    .map(item => item.code)
    .sort()
}

test('a document with no heading is E1001', () => {
  assert.deepEqual(codes(''), ['E1001'])
  assert.deepEqual(codes('just prose\n'), ['E1001'])
})

test('an unknown section keyword is E1002', () => {
  assert.deepEqual(codes('# struct point\n'), ['E1002'])
})

test('a namespace must be an identifier', () => {
  assert.deepEqual(codes('# namespace 9a\n'), ['E1003'])
  assert.deepEqual(codes('# namespace demo\n'), [])
})

test('dependencies must come first and at most once', () => {
  const text = [
    '# namespace demo',
    'purpose',
    '',
    '# dependencies',
    '```xl',
    'import { a } from "./a.xl.md"',
    '```',
    '',
  ].join('\n')
  assert.deepEqual(codes(text), ['E1004'])
})

test('a module-level declaration after a type declaration is E1005', () => {
  const text = [
    '# class point',
    '',
    '# method make:()=>int',
    '```ts',
    'return 1;',
    '```',
    '',
  ].join('\n')
  assert.deepEqual(codes(text), ['E1005'])
})

test('a dependency line that is not an import is E1006', () => {
  const text = [
    '# dependencies',
    '```xl',
    'const a = 1',
    '```',
    '',
  ].join('\n')
  assert.deepEqual(codes(text), ['E1006'])
})

test('an interface with implements is E1102, and its members must be declarations', () => {
  assert.deepEqual(codes('# interface a implements b\n'), ['E1102'])
  const constructor = ['# interface a', '', '## constructor:()=>void', ''].join('\n')
  assert.ok(codes(constructor).includes('E1102'))
})

test('a malformed generic list is E1103', () => {
  assert.deepEqual(codes('# class c<T extends>\n'), ['E1103'])
})

test('duplicate top-level names are E1106', () => {
  const text = ['# class point', '', '# class point', ''].join('\n')
  assert.deepEqual(codes(text), ['E1106'])
})

test('a # type without an assignment is E1108', () => {
  assert.deepEqual(codes('# type MemberKind\n'), ['E1108'])
})

test('an enum without cases is E1109, and duplicate cases are too', () => {
  assert.deepEqual(codes('# enum color\n'), ['E1109'])
  const text = ['# enum color', '- case red', '- case red', ''].join('\n')
  assert.deepEqual(codes(text), ['E1109'])
})

test('an unknown member kind is E1201', () => {
  const text = ['# class point', '', '## attr x:int', ''].join('\n')
  assert.deepEqual(codes(text), ['E1201'])
})

test('illegal modifiers are E1202', () => {
  const readonlyProperty = ['# class c', '', '## readonly property x:int', '### get', ''].join('\n')
  assert.ok(codes(readonlyProperty).includes('E1202'))
  const staticConstructor = ['# class c', '', '## static constructor:()=>void', ''].join('\n')
  assert.ok(codes(staticConstructor).includes('E1202'))
  const protectedTopLevel = ['# protected class c', ''].join('\n')
  assert.ok(codes(protectedTopLevel).includes('E1202'))
})

test('several visibility modifiers are E1211', () => {
  const text = ['# class c', '', '## public private field x:int = 0', ''].join('\n')
  assert.deepEqual(codes(text), ['E1211'])
})

test('an unbalanced type annotation is E1204', () => {
  const text = ['# class c', '', '## field x:Array<int', ''].join('\n')
  assert.ok(codes(text).includes('E1204'))
})

test('a duplicate member is E1205', () => {
  const text = ['# class c', '', '## field x:int = 0', '', '## field x:int = 1', ''].join('\n')
  assert.ok(codes(text).includes('E1205'))
})

test('a duplicate constructor is E1206', () => {
  const text = [
    '# class c',
    '',
    '## constructor:(x:int)=>void',
    '',
    '## constructor:(y:int)=>void',
    '',
  ].join('\n')
  assert.ok(codes(text).includes('E1206'))
})

test('a constructor that returns a value is E1206', () => {
  const text = ['# class c', '', '## constructor:(x:int)=>int', ''].join('\n')
  assert.ok(codes(text).includes('E1206'))
})

test('a literal type mismatch is E1207', () => {
  const text = ['# class c', '', '## field x:int = "0"', ''].join('\n')
  assert.ok(codes(text).includes('E1207'))
})

test('an optional parameter before a required one is E1208', () => {
  const text = ['# method m:(a?:int, b:int)=>void', '```ts', '```', ''].join('\n')
  assert.ok(codes(text).includes('E1208'))
})

test('a property without accessors is E1209', () => {
  const text = ['# class c', '', '## property label:string', ''].join('\n')
  assert.deepEqual(codes(text), ['E1209'])
})

test('set before get is E1210', () => {
  const text = ['# class c', '', '## property label:string', '### set', '### get', ''].join('\n')
  assert.ok(codes(text).includes('E1210'))
})

test('a malformed enum member line is E1212', () => {
  const text = ['# enum color', '- red', ''].join('\n')
  assert.ok(codes(text).includes('E1212'))
})

test('two default-language blocks in one member is E1301', () => {
  const text = [
    '# method m:()=>int',
    '```ts',
    'return 1;',
    '```',
    '```ts',
    'return 2;',
    '```',
    '',
  ].join('\n')
  assert.deepEqual(codes(text), ['E1301'])
})

test('a non-ts default fence is E1302', () => {
  const text = ['# method m:()=>int', '```js', 'return 1;', '```', ''].join('\n')
  assert.deepEqual(codes(text), ['E1302'])
})

test('an interface member with a body is E1304', () => {
  const text = ['# interface p', '', '## method print:()=>string', '```ts', 'return "x";', '```', ''].join('\n')
  assert.ok(codes(text).includes('E1304'))
})

test('a duplicate language sub-heading is E1303', () => {
  const text = [
    '# method m:()=>int',
    '```ts',
    'return 1;',
    '```',
    '',
    '## csharp',
    '```csharp',
    'return 1;',
    '```',
    '',
    '## csharp',
    '```csharp',
    'return 2;',
    '```',
    '',
  ].join('\n')
  assert.deepEqual(codes(text), ['E1303'])
})

test('an unknown sub-heading is E1305', () => {
  const text = ['# class c', '', '## method m:()=>int', '### note', ''].join('\n')
  assert.ok(codes(text).includes('E1305'))
})

test('the parser records fields, accessors, and enum cases', () => {
  const text = [
    '# class box',
    '',
    '## static readonly field ORIGIN:string = "0,0"',
    '',
    '## property label:string = "unnamed"',
    '### get',
    '### private set',
    '',
    '# enum color',
    '- case red',
    '- case green = 2',
    '',
  ].join('\n')
  const { doc, diagnostics } = parseXlMd(text, 'x.xl.md')
  assert.deepEqual(diagnostics.filter(item => item.severity === 'error'), [])
  const [box, color] = doc.decls
  assert.deepEqual(box.members[0].modifiers, ['static', 'readonly'])
  assert.deepEqual(box.members[1].accessors.map(accessor => accessor.kind), ['get', 'set'])
  assert.deepEqual(box.members[1].accessors[1].modifiers, ['private'])
  assert.deepEqual(color.cases.map(item => [item.name, item.value]), [['red', null], ['green', '2']])
})

test('a class header keeps generics, extends, and implements in order', () => {
  const text = ['# class box<T extends object, V = any> extends point implements printable, named', ''].join('\n')
  const { doc, diagnostics } = parseXlMd(text, 'x.xl.md')
  assert.deepEqual(diagnostics, [])
  assert.deepEqual(doc.decls[0].typeParams, [
    { name: 'T', constraint: 'object', default: null },
    { name: 'V', constraint: null, default: 'any' },
  ])
  assert.equal(doc.decls[0].extends, 'point')
  assert.deepEqual(doc.decls[0].implements, ['printable', 'named'])
})

test('a language section is recognized by name or by a matching fence', () => {
  const known = ['# class c', '', '## method m:()=>int', '```ts', 'return 1;', '```', '', '### csharp', '```csharp', 'return 1;', '```', ''].join('\n')
  assert.deepEqual(codes(known), [])
  const byFence = ['# class c', '', '## method m:()=>int', '```ts', 'return 1;', '```', '', '### mylang', '```mylang', 'return 1;', '```', ''].join('\n')
  assert.deepEqual(codes(byFence), [])
})

test('a heading inside a fenced block is content, not structure', () => {
  const text = ['# method m:()=>int', '```ts', '# not a heading', 'return 1;', '```', ''].join('\n')
  const { doc, diagnostics } = parseXlMd(text, 'x.xl.md')
  assert.deepEqual(diagnostics, [])
  assert.equal(doc.decls[0].body.rawBody, '# not a heading\nreturn 1;')
})
