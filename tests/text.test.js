/**
 * Text primitives: bracket-depth scanning around `=>` arrows.
 *
 * A `=>` arrow is one token. Its `>` is an arrow head, not a generic close;
 * counting it drives the depth negative and then hides every later top-level
 * separator. These are regression tests for the bug that made a parameter list
 * containing a function-typed parameter unsplittable (`E1204`).
 *
 * @module xl/tests/text
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { indexTopLevel, matchPair, splitTopLevel } from '../src/core/text.js'

test('splitTopLevel splits after a function-typed parameter', () => {
  assert.deepEqual(
    splitTopLevel('predicate:(item:T)=>bool, items:Array<T>'),
    ['predicate:(item:T)=>bool', 'items:Array<T>'],
  )
})

test('splitTopLevel splits a list that holds several function types', () => {
  assert.deepEqual(
    splitTopLevel('getValue:(index:int)=>ValueType, getCount:()=>int, Parent?:SourceRange<ValueType>'),
    ['getValue:(index:int)=>ValueType', 'getCount:()=>int', 'Parent?:SourceRange<ValueType>'],
  )
})

test('splitTopLevel still ignores separators nested in brackets', () => {
  assert.deepEqual(splitTopLevel('a:Array<int, string>, b:int'), ['a:Array<int, string>', 'b:int'])
})

test('splitTopLevel keeps a nested generic close intact', () => {
  assert.deepEqual(splitTopLevel('a:Map<string,Array<int>>, b:int'), ['a:Map<string,Array<int>>', 'b:int'])
})

test('splitTopLevel ignores separators inside quotes', () => {
  assert.deepEqual(splitTopLevel('"a,b", c'), ['"a,b"', 'c'])
})

test('indexTopLevel finds a separator that follows a function type', () => {
  assert.equal(indexTopLevel('f:(a:int)=>void, b:int', ','), 15)
  assert.equal(indexTopLevel('f:(a:int)=>void|b', '|'), 15)
})

test('matchPair closes a generic that contains an arrow constraint', () => {
  assert.equal(matchPair('<T extends (a:int)=>void>', 0), 25)
  assert.equal(matchPair('Array<int>', 5), 10)
})

test('matchPair still closes a plain parenthesized group', () => {
  assert.equal(matchPair('(a:int)', 0), 7)
})
