/**
 * TypeScript printer tests: the mapping rules the base case does not pin.
 *
 * @module xl/tests/emit-ts
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { printTypeScriptBody } from '../src/core/emit-ts.js'
import { parseXlMd } from '../src/core/parse.js'

/**
 * Print the body of a source.
 * @param {string} text - source text.
 * @returns {string} the printed body.
 */
function print(text) {
  const { doc, diagnostics } = parseXlMd(text, 'x.xl.md')
  const errors = diagnostics.filter(item => item.severity === 'error')
  assert.deepEqual(errors, [], 'the source must parse without errors')
  return printTypeScriptBody(doc)
}

test('a full source with dependencies is printed in order', () => {
  const text = [
    '# dependencies',
    '```xl',
    'import { level } from "./util.xl.md"',
    '```',
    '',
    '```ts',
    'import _ from "lodash";',
    '```',
    '',
    '# const MAX:int = 8',
    'cap.',
    '',
  ].join('\n')
  assert.equal(print(text), [
    'import _ from "lodash";',
    'import { level } from "./util";',
    '',
    'export const MAX: number = 8;',
  ].join('\n'))
})

test('a handwritten import of the same module suppresses the generated one', () => {
  const text = [
    '# dependencies',
    '```xl',
    'import { level } from "./util.xl.md"',
    '```',
    '',
    '```ts',
    'import { level } from "./util";',
    '```',
    '',
    '# const MAX:int = 8',
    'cap.',
    '',
  ].join('\n')
  assert.equal(print(text).split('\n')[0], 'import { level } from "./util";')
  assert.equal(print(text).includes('import { level } from "./util";\nimport'), false)
})

test('two xl imports of one module merge into one statement', () => {
  const text = [
    '# dependencies',
    '```xl',
    'import { a } from "./util.xl.md"',
    'import { b } from "./util.xl.md"',
    '```',
    '',
    '# const MAX:int = 8',
    'cap.',
    '',
  ].join('\n')
  assert.ok(print(text).includes('import { a, b } from "./util";'))
})

test('a renamed xl import keeps its alias', () => {
  const text = [
    '# dependencies',
    '```xl',
    'import { level as lv } from "./util.xl.md"',
    '```',
    '',
    '# const MAX:int = 8',
    'cap.',
    '',
  ].join('\n')
  assert.ok(print(text).includes('import { level as lv } from "./util";'))
})

test('a private top-level declaration is not exported', () => {
  assert.equal(print(['# private method m:()=>int', '```ts', 'return 1;', '```', ''].join('\n')), [
    'function m(): number {',
    '  return 1;',
    '}',
  ].join('\n'))
})

test('a module-level generator gets a star and Generator return type', () => {
  assert.ok(print(['# method tick:()=>int', '```ts', 'yield 1;', '```', ''].join('\n'))
    .startsWith('export function* tick(): Generator<number> {'))
})

test('an async module-level method wraps its return type in Promise', () => {
  assert.ok(print(['# method load:async (url:string)=>string', '```ts', 'return url;', '```', ''].join('\n'))
    .startsWith('export async function load(url: string): Promise<string> {'))
})

test('an already-wrapped return type is not wrapped twice', () => {
  assert.ok(print(['# method load:async (url:string)=>Promise<string>', '```ts', 'return url;', '```', ''].join('\n'))
    .includes(': Promise<string> {'))
})

test('an empty body becomes a one-line empty block', () => {
  assert.equal(print(['# method m:()=>int', ''].join('\n')), 'export function m(): number {}')
})

test('a class field with a code-block initializer is a single line', () => {
  const text = [
    '# class cache',
    '',
    '## field data:Map<K,V>',
    '```ts',
    'new Map()',
    '```',
    '',
  ].join('\n')
  assert.ok(print(text).includes('  public data: Map<K, V> = new Map();'))
})

test('a multi-line initializer keeps its shape', () => {
  const text = [
    '# const RULES:ReadonlyArray<string>',
    'codes.',
    '```ts',
    '[',
    '  "E1001",',
    ']',
    '```',
    '',
  ].join('\n')
  assert.equal(print(text), [
    'export const RULES: readonly string[] = [',
    '  "E1001",',
    '];',
  ].join('\n'))
})

test('an array of arrays maps recursively without extra parentheses', () => {
  const text = ['# method chunk2:(list:Array<Array<int>>)=>Array<Array<int>>', '```ts', 'return [list];', '```', ''].join('\n')
  assert.ok(print(text).includes('(list: number[][]): number[][]'))
})

test('a union element type is parenthesized before the array suffix', () => {
  const text = ['# method m:(list:Array<string | null>)=>void', '```ts', 'return;', '```', ''].join('\n')
  assert.ok(print(text).includes('(list: (string | null)[])'))
})

test('a function type maps its parameter names and types', () => {
  const text = ['# method m:(f:(a:int)=>void)=>void', '```ts', 'return;', '```', ''].join('\n')
  assert.ok(print(text).includes('(f: (a: number) => void)'))
})

test('a property with only get emits no setter and no backing field for a computed value', () => {
  const text = [
    '# class c',
    '',
    '## property score:int',
    '### get',
    '```ts',
    'return 1;',
    '```',
    '',
  ].join('\n')
  const body = print(text)
  assert.ok(body.includes('  public get score(): number {'))
  assert.equal(body.includes('#score'), false)
  assert.equal(body.includes('set score'), false)
})

test('a property with only set emits a backing field and a setter', () => {
  const text = [
    '# class c',
    '',
    '## property score:int',
    '### set',
    '```ts',
    'this.raw = value;',
    '```',
    '',
  ].join('\n')
  const body = print(text)
  assert.ok(body.includes('  #score: number;'))
  assert.ok(body.includes('  public set score(value: number) {'))
  assert.equal(body.includes('get score'), false)
})

test('a property with an initial value and a getter body keeps both', () => {
  const text = [
    '# class c',
    '',
    '## property score:int = 3',
    '### get',
    '```ts',
    'return this.raw;',
    '```',
    '',
  ].join('\n')
  const body = print(text)
  assert.ok(body.includes('  #score: number = 3;'))
  assert.ok(body.includes('  public get score(): number { return this.raw; }'))
})

test('a generator accessor becomes a starred method', () => {
  const text = [
    '# class c',
    '',
    '## property parts:int',
    '### get',
    '```ts',
    'yield 1;',
    '```',
    '',
  ].join('\n')
  assert.ok(print(text).includes('  public *parts(): Generator<number> {'))
})

test('an interface member never carries visibility', () => {
  const text = [
    '# interface printable',
    '',
    '## field id:string',
    '',
    '## method print:()=>string',
    '',
  ].join('\n')
  assert.equal(print(text), [
    'export interface printable {',
    '  id: string;',
    '  print(): string;',
    '}',
  ].join('\n'))
})

test('an empty interface and an empty class both print two lines', () => {
  assert.equal(print(['# interface x', ''].join('\n')), 'export interface x {\n}')
  assert.equal(print(['# class cache', ''].join('\n')), 'export class cache {\n}')
})

test('an enum has no trailing comma and keeps verbatim values', () => {
  const text = ['# enum color', '- case red', '- case green = 2', '- case blue', ''].join('\n')
  assert.equal(print(text), [
    'export enum color {',
    '  red,',
    '  green = 2,',
    '  blue',
    '}',
  ].join('\n'))
})

test('blank lines follow the base case: compact fields tight, expanded members spaced', () => {
  const text = [
    '# class point',
    '',
    '## field x:int = 0',
    '',
    '## field y:int = 0',
    '',
    '## method move:(dx:int)=>void',
    '```ts',
    'this.x = dx;',
    '```',
    '',
    '## method stop:()=>void',
    '```ts',
    'this.x = 0;',
    '```',
    '',
  ].join('\n')
  assert.equal(print(text), [
    'export class point {',
    '  public x: number = 0;',
    '  public y: number = 0;',
    '',
    '  public move(dx: number): void {',
    '    this.x = dx;',
    '  }',
    '',
    '  public stop(): void {',
    '    this.x = 0;',
    '  }',
    '}',
  ].join('\n'))
})

test('a top-level private class is not exported', () => {
  assert.ok(print(['# private class helper', ''].join('\n')).startsWith('class helper {'))
})

test('a literal type and a type alias are kept verbatim', () => {
  const text = [
    '# type MemberKind = "field" | "method"',
    'kinds.',
    '',
    '# interface printable',
    '',
    '## readonly field kind:"printable"',
    '',
  ].join('\n')
  assert.equal(print(text), [
    'export type MemberKind = "field" | "method";',
    '',
    'export interface printable {',
    '  readonly kind: "printable";',
    '}',
  ].join('\n'))
})

test('a # statement body is printed verbatim, without export', () => {
  const text = [
    '# const MAX:int = 8',
    'cap.',
    '',
    '# statement',
    'entry.',
    '```ts',
    '  if (MAX > 0) {',
    '    run();',
    '  }',
    '```',
    '',
  ].join('\n')
  assert.equal(print(text), [
    'export const MAX: number = 8;',
    '',
    'if (MAX > 0) {',
    '  run();',
    '}',
  ].join('\n'))
})

test('every # statement section is its own segment, in source order', () => {
  const text = [
    '# statement',
    '```ts',
    'first();',
    '```',
    '',
    '# class point',
    '',
    '# statement',
    '```ts',
    'second();',
    '```',
    '',
  ].join('\n')
  assert.equal(print(text), [
    'first();',
    '',
    'export class point {',
    '}',
    '',
    'second();',
  ].join('\n'))
})

test('# statement without a ts block contributes no segment', () => {
  const text = ['# statement', '## csharp', '```csharp', 'Main(args);', '```', ''].join('\n')
  assert.equal(print(text), '')
})
