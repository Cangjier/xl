/**
 * The structural digest and the structural read-back check (xl-cli §3.4).
 *
 * The digest is what the non-ts channel hands a generator as the contract the
 * product must satisfy; the check is how xl confirms the product still
 * satisfies it. The check is deliberately a symbol scan, not a parser: it
 * verifies the type set, the member set, and parameter counts, and leaves code
 * correctness to the target language's own compiler.
 *
 * @module xl/core/verify
 */

import { mapType } from './types.js'

/**
 * Build the compact, JSON-serializable structural digest of a document.
 * @param {object} doc - parsed document.
 * @returns {object} the digest.
 */
export function structureSummary(doc) {
  const summary = {
    file: doc.file,
    namespace: doc.namespace === null ? null : doc.namespace.name,
    module: doc.decls.filter(decl => decl.kind === 'type' || decl.kind === 'const' || decl.kind === 'method')
      .map(decl => summarizeModule(decl)),
    types: doc.decls.filter(decl => decl.kind === 'enum' || decl.kind === 'interface' || decl.kind === 'class')
      .map(decl => summarizeType(decl)),
  }
  // Present only when the source has statements, so a document without any
  // keeps the prompt hash it had before `# statement` existed.
  const statements = doc.decls.filter(decl => decl.kind === 'statement')
  if (statements.length > 0) {
    summary.statements = statements.map((decl, index) => summarizeStatement(decl, index + 1))
  }
  return summary
}

/**
 * Summarize one `# statement` section (xl-emit-ts §14).
 *
 * It declares no name, so the digest identifies it by position and records only
 * what a generator needs: whether a ts body exists and which target sections
 * accompany it. The body text itself is the source's business, not the digest's.
 * @param {object} decl - the statement declaration.
 * @param {number} ordinal - 1-based position among the file's statements.
 * @returns {object} the digest entry.
 */
function summarizeStatement(decl, ordinal) {
  return {
    index: ordinal,
    hasBody: decl.body !== null,
    ...decl.sections.length === 0 ? {} : { sections: decl.sections.map(section => section.lang) },
  }
}

/**
 * Summarize one module-level declaration.
 * @param {object} decl - the declaration.
 * @returns {object} the digest entry.
 */
function summarizeModule(decl) {
  const entry = { kind: decl.kind, name: decl.name }
  if (decl.modifiers.length > 0) entry.modifiers = [...decl.modifiers]
  if (decl.kind === 'type') entry.typeText = decl.typeTextRaw
  if (decl.kind === 'const') {
    entry.type = mapType(decl.type)
    entry.hasInitialValue = decl.defaultValue !== undefined || decl.body !== null
  }
  if (decl.kind === 'method') {
    entry.params = summarizeParams(decl.params)
    entry.returns = mapType(decl.returns)
    entry.paramCount = decl.params.length
    if (decl.async) entry.async = true
    if (decl.typeParams.length > 0) entry.typeParams = decl.typeParams.map(param => param.name)
    if (decl.body === null) entry.hasBody = false
  }
  if (decl.prose === '') entry.hasProse = false
  return entry
}

/**
 * Summarize one type declaration.
 * @param {object} decl - the declaration.
 * @returns {object} the digest entry.
 */
function summarizeType(decl) {
  const entry = { kind: decl.kind, name: decl.name }
  if (decl.modifiers.length > 0) entry.modifiers = [...decl.modifiers]
  if (decl.extends !== null) entry.extends = decl.extends
  if (decl.implements.length > 0) entry.implements = [...decl.implements]
  if (decl.typeParams.length > 0) {
    entry.typeParams = decl.typeParams.map(param => ({
      name: param.name,
      ...param.constraint === null ? {} : { constraint: param.constraint },
      ...param.default === null ? {} : { default: param.default },
    }))
  }
  if (decl.kind === 'enum') {
    entry.cases = decl.cases.map(item => ({ name: item.name, value: item.value }))
    return entry
  }
  entry.members = decl.members.map(member => summarizeMember(member, decl.kind))
  if (decl.prose === '') entry.hasProse = false
  return entry
}

/**
 * Summarize one class or interface member.
 * @param {object} member - the member.
 * @param {'class' | 'interface'} ownerKind - the declaring type's kind.
 * @returns {object} the digest entry.
 */
function summarizeMember(member, ownerKind) {
  const entry = { kind: member.kind }
  if (member.name !== '') entry.name = member.name
  if (member.modifiers.length > 0) entry.modifiers = [...member.modifiers]
  switch (member.kind) {
    case 'field':
      entry.type = mapType(member.type)
      if (member.optional) entry.optional = true
      if (member.defaultValue !== undefined) entry.default = member.defaultValue
      if (member.defaultValue !== undefined || member.body !== null) entry.hasInitialValue = true
      break
    case 'property': {
      entry.type = mapType(member.type)
      entry.accessors = member.accessors.map(accessor => ({
        kind: accessor.kind,
        ...accessor.modifiers.length === 0 ? {} : { modifiers: [...accessor.modifiers] },
        hasBody: accessor.body !== null,
      }))
      if (member.defaultValue !== undefined) {
        entry.hasInitialValue = true
        entry.default = member.defaultValue
      }
      break
    }
    case 'method':
      entry.params = summarizeParams(member.params)
      entry.paramCount = member.params.length
      entry.returns = mapType(member.returns)
      if (member.async) entry.async = true
      if (member.typeParams.length > 0) entry.typeParams = member.typeParams.map(param => param.name)
      entry.hasBody = member.body !== null
      break
    case 'constructor':
      entry.params = summarizeParams(member.params)
      entry.paramCount = member.params.length
      entry.hasBody = member.body !== null
      break
    default:
      break
  }
  if (ownerKind === 'class' && member.prose === '') entry.hasProse = false
  return entry
}

/**
 * Summarize a parameter list.
 * @param {readonly object[]} params - parameters.
 * @returns {object[]} the digest entries.
 */
function summarizeParams(params) {
  return params.map(param => ({
    name: param.name,
    type: mapType(param.type),
    ...param.optional ? { optional: true } : {},
    ...param.defaultValue === undefined ? {} : { default: param.defaultValue },
  }))
}

/**
 * Scan generated text for the type names it declares.
 * @param {string} text - generated product text.
 * @returns {Set<string>} declared type names.
 */
export function declaredTypeNames(text) {
  const names = new Set()
  const pattern = /\b(?:class|interface|enum|struct|record|trait|protocol|object|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
  for (const match of text.matchAll(pattern)) names.add(match[1])
  return names
}

/**
 * Scan generated text for the parameter counts of every declaration of a name.
 *
 * A name may be declared more than once (overloads, or a getter beside a
 * setter), so the count check accepts any matching declaration.
 * @param {string} text - generated product text.
 * @param {string} name - member name.
 * @returns {number[]} the parameter counts found.
 */
export function parameterCounts(text, name) {
  const counts = []
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\\b${escaped}\\b\\s*(?:<[^<>()]*>)?\\s*\\(`, 'g')
  for (const match of text.matchAll(pattern)) {
    const open = match.index + match[0].length - 1
    const close = matchingParen(text, open)
    if (close < 0) continue
    counts.push(countTopLevelCommas(text.slice(open + 1, close)))
  }
  return counts
}

/**
 * Index of the parenthesis matching the one at `open`.
 * @param {string} text - text to scan.
 * @param {number} open - index of the opening parenthesis.
 * @returns {number} the matching index, or -1.
 */
function matchingParen(text, open) {
  let depth = 0
  let quote = null
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Count comma-separated arguments in a parameter list body; an empty or
 * whitespace-only body has no arguments.
 *
 * A `=>` arrow is consumed as one token: a generated product routinely contains
 * arrows (lambdas, function types), and counting the arrow's `>` as a close
 * would drive the depth negative and hide every later top-level comma.
 * @param {string} body - text between the parentheses.
 * @returns {number} the argument count.
 */
function countTopLevelCommas(body) {
  if (body.trim() === '') return 0
  let depth = 0
  let count = 1
  let quote = null
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '=' && body[index + 1] === '>') {
      index += 1
      continue
    }
    if (char === '(' || char === '<' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === '>' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) count += 1
  }
  return count
}

/**
 * Verify a generated product against the document's structure.
 *
 * Checks the three documented facts: the type set, the member-name set, and
 * parameter counts. Anything else is the target compiler's business.
 * @param {object} doc - parsed document.
 * @param {string} generated - the generated product text.
 * @param {object} [options] - verification scope.
 * @param {ReadonlySet<string>} [options.only] - restrict the check to these declaration names; used when a `type` layout splits one source across several files.
 * @returns {{ok: boolean, issues: string[], missingTypes: string[], missingMembers: string[], parameterMismatches: object[]}} the verdict.
 */
export function verifyStructure(doc, generated, options = {}) {
  const issues = []
  const missingTypes = []
  const missingMembers = []
  const parameterMismatches = []
  const declared = declaredTypeNames(generated)
  const inScope = decl => options.only === undefined || options.only.has(decl.name)

  for (const decl of doc.decls) {
    if (decl.kind !== 'enum' && decl.kind !== 'interface' && decl.kind !== 'class') continue
    if (!inScope(decl)) continue
    const hasDeclaration = declared.has(decl.name)
    const mentioned = new RegExp(`\\b${escapeRegExp(decl.name)}\\b`).test(generated)
    if (!hasDeclaration && !mentioned) {
      missingTypes.push(decl.name)
      issues.push(`${decl.kind} "${decl.name}" is absent from the generated code`)
      continue
    }
    for (const member of decl.members) {
      if (member.name === '' || member.kind === 'constructor') continue
      if (!new RegExp(`\\b${escapeRegExp(member.name)}\\b`).test(generated)) {
        missingMembers.push(`${decl.name}.${member.name}`)
        issues.push(`member "${member.name}" of "${decl.name}" is absent from the generated code`)
        continue
      }
      if (member.kind !== 'method') continue
      const counts = parameterCounts(generated, member.name)
      if (counts.length > 0 && !counts.includes(member.params.length)) {
        parameterMismatches.push({
          owner: decl.name,
          member: member.name,
          expected: member.params.length,
          found: counts,
        })
        issues.push(`member "${member.name}" of "${decl.name}" expects ${member.params.length} parameter(s), the generated code declares ${counts.join(' / ')}`)
      }
    }
  }

  for (const decl of doc.decls) {
    if (decl.kind !== 'method' && decl.kind !== 'const' && decl.kind !== 'type') continue
    if (decl.name === '') continue
    if (!inScope(decl)) continue
    if (!new RegExp(`\\b${escapeRegExp(decl.name)}\\b`).test(generated)) {
      missingMembers.push(decl.name)
      issues.push(`module-level ${decl.kind} "${decl.name}" is absent from the generated code`)
      continue
    }
    if (decl.kind !== 'method') continue
    const counts = parameterCounts(generated, decl.name)
    if (counts.length > 0 && !counts.includes(decl.params.length)) {
      parameterMismatches.push({
        owner: null,
        member: decl.name,
        expected: decl.params.length,
        found: counts,
      })
      issues.push(`module-level method "${decl.name}" expects ${decl.params.length} parameter(s), the generated code declares ${counts.join(' / ')}`)
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    missingTypes,
    missingMembers,
    parameterMismatches,
  }
}

/**
 * Escape a literal for use inside a regular expression.
 * @param {string} text - literal text.
 * @returns {string} escaped text.
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
