/**
 * Parser tests: IR construction and the syntax / structure diagnostics.
 *
 * @module xl/tests/parse
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { indexAssign, parseXlMd } from '../src/core/parse.js'

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

test('a module-level declaration may follow a type declaration', () => {
  const text = [
    '# class point',
    '',
    '# method make:()=>int',
    '```ts',
    'return 1;',
    '```',
    '',
  ].join('\n')
  assert.deepEqual(codes(text), [])
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

test('an accessor under a non-property member is still E1209', () => {
  const text = ['# class c', '', '## method m:()=>int', '### get', ''].join('\n')
  assert.ok(codes(text).includes('E1209'))
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

test('a property without accessors is legal and defaults to get and set', () => {
  const text = ['# class c', '', '## property label:string', ''].join('\n')
  assert.deepEqual(codes(text), [])
  const { doc } = parseXlMd(text, 'x.xl.md')
  const property = doc.decls[0].members[0]
  assert.deepEqual(property.accessors.map(accessor => accessor.kind), ['get', 'set'])
  assert.deepEqual(property.accessors.map(accessor => accessor.synthesized), [true, true])
})

test('set may be written before get; the emitted order is still get then set', () => {
  const text = ['# class c', '', '## property label:string', '### set', '### get', ''].join('\n')
  assert.deepEqual(codes(text), [])
  const { doc } = parseXlMd(text, 'x.xl.md')
  assert.deepEqual(doc.decls[0].members[0].accessors.map(accessor => accessor.kind), ['get', 'set'])
})

test('an interface may declare a property and generic parameters', () => {
  const text = [
    '# interface holder<T extends object>',
    '',
    '## field id:string',
    '',
    '## property value:T',
    '### get',
    '',
    '## method size:()=>int',
    '',
  ].join('\n')
  assert.deepEqual(codes(text), [])
  const { doc } = parseXlMd(text, 'x.xl.md')
  assert.deepEqual(doc.decls[0].typeParams, [{ name: 'T', constraint: 'object', default: null }])
  assert.deepEqual(doc.decls[0].members.map(member => member.kind), ['field', 'property', 'method'])
  assert.deepEqual(doc.decls[0].members[1].accessors.map(accessor => accessor.kind), ['get'])
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

test('a parameter list may hold function-typed parameters', () => {
  const text = ['# method bind:(predicate:(item:int)=>bool, items:Array<int>)=>bool', ''].join('\n')
  assert.deepEqual(codes(text), [])
  const { doc } = parseXlMd(text, 'x.xl.md')
  assert.deepEqual(doc.decls[0].params.map(param => param.name), ['predicate', 'items'])
  assert.equal(doc.decls[0].params[0].typeText, '(item:int)=>bool')
  assert.equal(doc.decls[0].params[1].typeText, 'Array<int>')
})

test('a constructor may hold a function-typed parameter', () => {
  const text = ['# class document', '', '## constructor:(getValue:(index:int)=>any, getCount:()=>int)=>void', ''].join('\n')
  assert.deepEqual(codes(text), [])
  const { doc } = parseXlMd(text, 'x.xl.md')
  assert.deepEqual(doc.decls[0].members[0].params.map(param => param.name), ['getValue', 'getCount'])
})

test('indexAssign skips the arrow of a function type', () => {
  assert.equal(indexAssign('f:(item:int)=>bool = true'), 19)
  assert.equal(indexAssign('(item:int)=>bool'), -1)
})

test('# statement needs a body, and takes no name or modifier', () => {
  assert.deepEqual(codes('# statement\n'), ['E1110'])
  const named = ['# statement entry', '```ts', 'run();', '```', ''].join('\n')
  assert.deepEqual(codes(named), ['E1203'])
  const modified = ['# private statement', '```ts', 'run();', '```', ''].join('\n')
  assert.deepEqual(codes(modified), ['E1202'])
})

test('# statement may sit anywhere: it constrains no declaration order', () => {
  const first = [
    '# statement', '```ts', 'run();', '```', '',
    '# method make:()=>int', '```ts', 'return 1;', '```', '',
  ].join('\n')
  assert.deepEqual(codes(first), [])
  const middle = [
    '# method make:()=>int', '```ts', 'return 1;', '```', '',
    '# statement', '```ts', 'run();', '```', '',
    '# class point', '',
  ].join('\n')
  assert.deepEqual(codes(middle), [])
  const last = ['# class point', '', '# statement', '```ts', 'run();', '```', ''].join('\n')
  assert.deepEqual(codes(last), [])
})

test('# statement keeps its prose, its body, and its language sections', () => {
  const text = [
    '# statement',
    '模块入口。',
    '```ts',
    '  run();',
    '```',
    '',
    '## csharp',
    '```csharp',
    'Run();',
    '```',
    '',
    '# statement',
    '',
    '## csharp',
    '```csharp',
    'Bootstrap();',
    '```',
    '',
  ].join('\n')
  const { doc, diagnostics } = parseXlMd(text, 'x.xl.md')
  assert.deepEqual(diagnostics, [], 'a statement covered by ## <lang> is complete without a ts body')
  assert.deepEqual(doc.decls.map(decl => decl.kind), ['statement', 'statement'])
  assert.equal(doc.decls[0].name, '')
  assert.equal(doc.decls[0].prose, '模块入口。')
  assert.equal(doc.decls[0].body.rawBody, '  run();')
  assert.deepEqual(doc.decls[0].sections.map(section => section.lang), ['csharp'])
  assert.equal(doc.decls[1].body, null)
})

test('a second default block under # statement is E1301, a non-ts fence is E1302', () => {
  const twice = ['# statement', '```ts', 'a();', '```', '', '```ts', 'b();', '```', ''].join('\n')
  assert.deepEqual(codes(twice), ['E1301'])
  const wrongFence = ['# statement', '```js', 'a();', '```', ''].join('\n')
  assert.deepEqual(codes(wrongFence), ['E1110', 'E1302'])
})

test('a static import inside # statement is W3013, a dynamic one is not', () => {
  const warnings = (text) => {
    return diagnosticsOf(text)
      .filter(item => item.severity === 'warning')
      .map(item => item.code)
      .sort()
  }
  const staticImport = ['# statement', '```ts', 'import x from "x";', 'run();', '```', ''].join('\n')
  assert.deepEqual(warnings(staticImport), ['W3013'])
  const reExport = ['# statement', '```ts', 'export { x } from "./x";', '```', ''].join('\n')
  assert.deepEqual(warnings(reExport), ['W3013'])
  const dynamic = ['# statement', '```ts', 'await import("node:fs");', 'import.meta.url;', '```', ''].join('\n')
  assert.deepEqual(warnings(dynamic), [])
})
