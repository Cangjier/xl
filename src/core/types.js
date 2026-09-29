/**
 * The xl type model and its TypeScript mapping (xl-emit-ts §4).
 *
 * A type annotation is parsed into a small tree so the printer can map it
 * recursively while leaving unknown names and literal types untouched.
 * `# type` right-hand sides never reach this module: they are verbatim.
 *
 * @module xl/core/types
 */

import { indexTopLevel, matchPair, splitTopLevel } from './text.js'

/** Scalar xl type names and their TypeScript spelling. */
const PRIMITIVES = new Map([
  ['int', 'number'],
  ['float', 'number'],
  ['double', 'number'],
  ['number', 'number'],
  ['bool', 'boolean'],
  ['boolean', 'boolean'],
  ['string', 'string'],
  ['any', 'any'],
  ['void', 'void'],
  ['undefined', 'undefined'],
  ['null', 'null'],
  ['never', 'never'],
  ['unknown', 'unknown'],
  ['object', 'object'],
])

/** Generic containers the printer maps by name, keeping their arguments. */
const CONTAINERS = new Set([
  'Array',
  'ReadonlyArray',
  'Map',
  'Set',
  'Promise',
  'Generator',
  'AsyncGenerator',
  'Record',
  'Partial',
  'Readonly',
])

/**
 * @typedef {object} TypeNode
 * @property {'primitive'|'ref'|'array'|'optional'|'union'|'function'|'raw'} kind Node kind.
 * @property {string} [name] Named type or primitive.
 * @property {TypeNode[]} [args] Generic arguments.
 * @property {TypeNode} [element] Array element type.
 * @property {TypeNode} [inner] Wrapped type (optional, grouping).
 * @property {TypeNode[]} [members] Union members.
 * @property {object[]} [params] Function parameter list.
 * @property {TypeNode} [returns] Function return type.
 * @property {string} [text] Verbatim text for a literal type.
 */

/**
 * Parse an xl type annotation.
 * @param {string} text - annotation body, without a trailing `?`.
 * @returns {TypeNode | null} the tree, or `null` when the text is empty or unbalanced.
 */
export function parseType(text) {
  const source = text.trim()
  if (source === '') return null
  const state = { source, index: 0 }
  const node = parseUnion(state)
  skipSpace(state)
  if (node === null || state.index !== source.length) return null
  return node
}

/**
 * Parse a commutative union `A | B | C`.
 * @param {{source: string, index: number}} state - parser state.
 * @returns {TypeNode | null} the node, or `null` on failure.
 */
function parseUnion(state) {
  const first = parsePostfix(state)
  if (first === null) return null
  const members = [first]
  for (;;) {
    skipSpace(state)
    if (state.source[state.index] !== '|') break
    state.index += 1
    const next = parsePostfix(state)
    if (next === null) return null
    members.push(next)
  }
  return members.length === 1 ? first : { kind: 'union', members }
}

/**
 * Parse array suffixes `T[]` and the optional marker `T?`.
 * @param {{source: string, index: number}} state - parser state.
 * @returns {TypeNode | null} the node, or `null` on failure.
 */
function parsePostfix(state) {
  let node = parsePrimary(state)
  if (node === null) return null
  for (;;) {
    if (state.source.startsWith('[]', state.index)) {
      state.index += 2
      node = { kind: 'array', element: node }
      continue
    }
    if (state.source[state.index] === '?') {
      state.index += 1
      node = { kind: 'optional', inner: node }
      continue
    }
    break
  }
  return node
}

/**
 * Parse a primitive, named, generic, function, or literal type.
 * @param {{source: string, index: number}} state - parser state.
 * @returns {TypeNode | null} the node, or `null` on failure.
 */
function parsePrimary(state) {
  skipSpace(state)
  const source = state.source
  if (source[state.index] === '(') {
    const end = matchPair(source, state.index)
    if (end < 0) return null
    const body = source.slice(state.index + 1, end - 1)
    let after = end
    while (after < source.length && /\s/.test(source[after])) after += 1
    if (source.startsWith('=>', after)) {
      state.index = after + 2
      const returns = parseUnion(state)
      if (returns === null) return null
      return { kind: 'function', params: parseParams(body), returns, raw: source.slice(state.index) }
    }
    // A parenthesized group: re-enter the parser over the inner text.
    const inner = parseType(body)
    if (inner === null) return null
    state.index = end
    return inner
  }
  if (source[state.index] === '"' || source[state.index] === "'") {
    const start = state.index
    const quote = source[state.index]
    let index = state.index + 1
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') index += 1
      index += 1
    }
    if (index >= source.length) return null
    state.index = index + 1
    return { kind: 'raw', text: source.slice(start, state.index) }
  }
  const literal = /^-?\d+(?:\.\d+)?/.exec(source.slice(state.index))
  if (literal !== null) {
    state.index += literal[0].length
    return { kind: 'raw', text: literal[0] }
  }
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(state.index))
  if (name === null) return null
  state.index += name[0].length
  let args = []
  if (source[state.index] === '<') {
    const end = matchPair(source, state.index)
    if (end < 0) return null
    const inner = source.slice(state.index + 1, end - 1)
    args = splitTopLevel(inner).map(part => parseType(part))
    if (args.some(argument => argument === null)) return null
    state.index = end
  }
  if (PRIMITIVES.has(name[0]) && args.length === 0) {
    return { kind: 'primitive', name: name[0] }
  }
  return { kind: 'ref', name: name[0], args }
}

/**
 * Advance past spaces and tabs.
 * @param {{source: string, index: number}} state - parser state.
 */
function skipSpace(state) {
  while (state.index < state.source.length && /\s/.test(state.source[state.index])) state.index += 1
}

/**
 * Parse a parameter list body into parameters. Used for function *types*; the
 * declaration parsers own their own, stricter parameter rules.
 * @param {string} body - the text between the parentheses.
 * @returns {object[]} parameters.
 */
function parseParams(body) {
  if (body.trim() === '') return []
  return splitTopLevel(body).map((part) => {
    const colon = indexTopLevel(part, ':')
    if (colon < 0) return { name: part.trim(), typeText: 'any', optional: false }
    const name = part.slice(0, colon).trim().replace(/\?$/, '')
    return {
      name,
      typeText: part.slice(colon + 1).trim(),
      optional: part.slice(0, colon).trim().endsWith('?'),
    }
  })
}

/**
 * Map a parsed type to TypeScript (xl-emit-ts §4).
 * @param {TypeNode | null} node - parsed type; `null` yields `any`.
 * @returns {string} TypeScript type text.
 */
export function mapType(node) {
  if (node === null || node === undefined) return 'any'
  switch (node.kind) {
    case 'primitive':
      return PRIMITIVES.get(node.name) ?? node.name
    case 'raw':
      return node.text ?? 'any'
    case 'array':
      return `${wrapForArray(mapType(node.element))}[]`
    case 'optional':
      return mapType(node.inner)
    case 'union':
      return node.members.map(mapType).join(' | ')
    case 'function':
      return `(${renderParams(node.params ?? [])}) => ${mapType(node.returns)}`
    case 'ref':
      return renderRef(node)
    default:
      return 'any'
  }
}

/**
 * Render a named type, applying the array/readonly/container rules.
 * @param {TypeNode} node - a `ref` node.
 * @returns {string} TypeScript type text.
 */
function renderRef(node) {
  const name = node.name ?? 'any'
  const args = node.args ?? []
  if (name === 'Array' && args.length === 1) {
    return `${wrapForArray(mapType(args[0]))}[]`
  }
  if (name === 'ReadonlyArray' && args.length === 1) {
    return `readonly ${wrapForArray(mapType(args[0]))}[]`
  }
  if (args.length > 0) {
    return `${name}<${args.map(mapType).join(', ')}>`
  }
  return PRIMITIVES.get(name) ?? name
}

/**
 * Whether a type name is a generic container xl knows by name.
 * @param {string} name - type name.
 * @returns {boolean} whether the name is a container.
 */
export function isContainerName(name) {
  return CONTAINERS.has(name)
}

/**
 * Wrap element text that cannot be suffixed directly with `[]`.
 * @param {string} text - mapped element type text.
 * @returns {string} text safe to suffix with `[]`.
 */
export function wrapForArray(text) {
  return indexTopLevel(text, '|') >= 0 || text.includes('=>') ? `(${text})` : text
}

/**
 * Wrap a return type in `Promise<…>` unless it already is one (xl-emit-ts §9.1).
 * @param {string} text - mapped return type.
 * @returns {string} the async return type.
 */
export function promiseOf(text) {
  return text.startsWith('Promise<') ? text : `Promise<${text}>`
}

/**
 * Wrap a return type in `Generator<…>` unless it already is one (xl-emit-ts §9.1).
 * @param {string} text - mapped return type.
 * @returns {string} the generator return type.
 */
export function generatorOf(text) {
  return text.startsWith('Generator<') ? text : `Generator<${text}>`
}

/**
 * Render one parameter for a function type.
 * @param {object} param - parameter with `name`, `typeText`, `optional`.
 * @returns {string} TypeScript parameter text.
 */
function renderParams(params) {
  return params.map((param) => {
    const type = mapType(parseType(param.typeText ?? 'any'))
    return `${param.name}${param.optional ? '?' : ''}: ${type}`
  }).join(', ')
}

/**
 * Whether a type tree mentions any of the given names. Used by `E1104` for
 * `extends` targets and by `E1105` for `implements` targets.
 * @param {TypeNode | null} node - parsed type tree.
 * @param {ReadonlySet<string>} names - names to look for.
 * @returns {boolean} whether the tree mentions a name.
 */
export function typeHasName(node, names) {
  if (node === null || node === undefined) return false
  switch (node.kind) {
    case 'primitive':
    case 'raw':
      return node.name !== undefined && names.has(node.name)
    case 'ref':
      if (node.name !== undefined && names.has(node.name)) return true
      return (node.args ?? []).some(argument => typeHasName(argument, names))
    case 'array':
      return typeHasName(node.element, names)
    case 'optional':
      return typeHasName(node.inner, names)
    case 'union':
      return node.members.some(member => typeHasName(member, names))
    case 'function':
      return typeHasName(node.returns, names)
        || (node.params ?? []).some(param => typeHasName(parseType(param.typeText ?? ''), names))
    default:
      return false
  }
}

/**
 * Names a type tree refers to, in source order. Used by `E1104`.
 * @param {TypeNode | null} node - parsed type tree.
 * @param {Set<string>} [into] - accumulator.
 * @returns {Set<string>} every referenced name.
 */
export function collectTypeNames(node, into = new Set()) {
  if (node === null || node === undefined) return into
  switch (node.kind) {
    case 'primitive':
      return into
    case 'raw':
      return into
    case 'ref':
      if (node.name !== undefined) into.add(node.name)
      for (const argument of node.args ?? []) collectTypeNames(argument, into)
      return into
    case 'array':
      return collectTypeNames(node.element, into)
    case 'optional':
      return collectTypeNames(node.inner, into)
    case 'union':
      for (const member of node.members) collectTypeNames(member, into)
      return into
    case 'function':
      collectTypeNames(node.returns, into)
      for (const param of node.params ?? []) collectTypeNames(parseType(param.typeText ?? ''), into)
      return into
    default:
      return into
  }
}
