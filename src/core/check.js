/**
 * The semantic checker: the rules that need the whole document rather than one
 * heading (xl-check §3.2, §3.3).
 *
 * The parser already reports everything decidable while reading a single
 * heading. This module adds the cross-member and cross-file rules, and the
 * generation-quality warnings that depend on the requested target languages.
 *
 * @module xl/core/check
 */

import { diag } from './diagnostics.js'
import { collectTypeNames } from './types.js'
import { TYPE_SECTION_KINDS } from './parse.js'

/**
 * Check one parsed document.
 * @param {object} input - the check input.
 * @param {object} input.doc - parsed document.
 * @param {string} input.file - POSIX source path.
 * @param {string} input.source - the source text.
 * @param {readonly object[]} input.targets - resolved target descriptors.
 * @param {object} [input.deps] - dependency index for this file.
 * @param {Map<string, string>} [input.deps.kinds] - imported name to declaration kind.
 * @param {object[]} [input.deps.problems] - diagnostics raised while resolving `# dependencies`.
 * @returns {object[]} diagnostics.
 */
export function checkDocument(input) {
  const { doc, file, targets } = input
  const diagnostics = [...input.deps?.problems ?? []]
  /** @param {string} code @param {number} line @param {string} msg @param {object} [extra] */
  const emit = (code, line, msg, extra = {}) => {
    diagnostics.push(diag({ code, file, line, msg, ...extra }))
  }

  // Names declared in this file, plus the enum cases; the dependency index
  // extends both maps so `extends` and `implements` resolve across files.
  // Duplicate names within the file are the parser's business (`E1106`), not
  // repeated here.
  const localTypes = new Map()
  const localAny = new Map()
  for (const decl of doc.decls) {
    // A `# statement` declares no symbol, so it enters neither name map.
    if (decl.kind === 'statement') continue
    localAny.set(decl.name, decl.kind)
    if (TYPE_SECTION_KINDS.has(decl.kind)) localTypes.set(decl.name, decl)
    if (decl.kind === 'enum') {
      for (const item of decl.cases) localAny.set(item.name, 'case')
    }
  }

  const dependencyKinds = input.deps?.kinds ?? new Map()
  /** @param {string} name @returns {boolean} whether the name resolves locally or through a dependency. */
  const resolves = name => localAny.has(name) || dependencyKinds.has(name)
  /** @param {string} name @returns {string | undefined} the kind of the resolved name. */
  const kindOf = name => localAny.get(name) ?? dependencyKinds.get(name)

  for (const decl of doc.decls) {
    checkDeclaration(decl, { emit, localTypes, resolves, kindOf })
  }

  checkTargetHints(doc, targets, emit)
  checkMemberProse(doc, emit)
  checkLanguageSections(doc, emit)

  return diagnostics
}

/**
 * Check one declaration's cross-document rules: whether its `extends` and
 * `implements` targets resolve, and whether an interface's members are all
 * implemented. Rules decidable from one file's IR alone live in the parser.
 * @param {object} decl - the declaration.
 * @param {object} helpers - `emit`, `localTypes`, `resolves`, and `kindOf`.
 */
function checkDeclaration(decl, helpers) {
  const { emit, localTypes, resolves, kindOf } = helpers
  if (decl.kind !== 'interface' && decl.kind !== 'class') return
  if (decl.extends !== null) {
    const names = collectTypeNames(typeNodeOf(decl.extends))
    for (const name of names) {
      if (!resolves(name) && !isBuiltinType(name)) {
        emit('E1104', decl.line, `"extends" target "${name}" is not declared in this file or its dependencies`)
      }
    }
    if (decl.kind === 'interface' && kindOf(decl.extends) !== undefined && kindOf(decl.extends) !== 'interface') {
      emit('E1105', decl.line, `"extends" target "${decl.extends}" is a ${kindOf(decl.extends)}, not an interface`)
    }
  }
  if (decl.kind !== 'class') return
  for (const name of decl.implements) {
    if (!resolves(name)) {
      emit('E1104', decl.line, `"implements" target "${name}" is not declared in this file or its dependencies`)
      continue
    }
    if (kindOf(name) !== 'interface') {
      emit('E1105', decl.line, `"implements" target "${name}" is a ${kindOf(name) ?? 'unknown declaration'}, not an interface`)
      continue
    }
    const target = localTypes.get(name)
    if (target === undefined) continue
    checkImplements(decl, target, emit)
  }
}

/**
 * Wrap an `extends` base name as a type node so the shared collector can walk
 * it without a second grammar: a base is always a plain identifier.
 * @param {string} text - the base type text.
 * @returns {object} the parsed type node.
 */
function typeNodeOf(text) {
  return { kind: 'ref', name: text, args: [] }
}

/**
 * Whether a name is a type xl knows without a declaration.
 * @param {string} name - type name.
 * @returns {boolean} whether the name is built in.
 */
function isBuiltinType(name) {
  return BUILTIN_TYPE_NAMES.has(name)
}

/** Type names that resolve without a declaration in the same file or a dependency. */
const BUILTIN_TYPE_NAMES = new Set([
  'int', 'float', 'double', 'number', 'bool', 'boolean', 'string', 'any',
  'void', 'object', 'Array', 'ReadonlyArray', 'Map', 'Set', 'Promise', 'Generator',
  'AsyncGenerator', 'Record', 'Partial', 'Readonly', 'unknown', 'never', 'undefined', 'null',
])

/**
 * Check that a class implements every member its interfaces declare.
 * @param {object} decl - the class declaration.
 * @param {object} target - the interface declaration.
 * @param {Function} emit - diagnostic sink.
 */
function checkImplements(decl, target, emit) {
  const declared = new Map()
  for (const member of decl.members) {
    if (member.name === '') continue
    declared.set(member.name, member.kind === 'method' ? member.params.length : -1)
  }
  for (const member of target.members) {
    if (member.name === '') continue
    // An optional field is satisfied by absence, so it imposes no obligation.
    if (member.kind === 'field' && member.optional) continue
    if (!declared.has(member.name)) {
      emit('E1105', decl.line, `class "${decl.name}" does not implement "${label(member)}" required by interface "${target.name}"`)
      continue
    }
    if (member.kind === 'method' && declared.get(member.name) !== member.params.length) {
      emit('E1105', decl.line, `class "${decl.name}" implements "${member.name}" with ${declared.get(member.name)} parameter(s), the interface declares ${member.params.length}`)
    }
  }
}

/**
 * Human label for a member in a diagnostic message.
 * @param {object} member - the member.
 * @returns {string} the label.
 */
function label(member) {
  return member.kind === 'method' ? `${member.name}(${member.params.length})` : member.name
}

/**
 * Warn when an executable member has no generation basis for a requested
 * target (`W3010`, xl-check §3.3).
 * @param {object} doc - parsed document.
 * @param {readonly object[]} targets - resolved target descriptors.
 * @param {Function} emit - diagnostic sink.
 */
function checkTargetHints(doc, targets, emit) {
  checkStatementHints(doc, targets, emit)
  const requested = targets.filter(target => target.name !== 'ts')
  if (requested.length === 0) return
  const members = []
  for (const decl of doc.decls) {
    if (decl.kind === 'method') members.push({ node: decl, name: decl.name, sections: decl.sections, body: decl.body, hintLine: decl.line })
    if (decl.kind !== 'class') continue
    for (const member of decl.members) {
      if (member.kind === 'method' || member.kind === 'constructor') {
        members.push({
          node: member,
          name: member.name === '' ? 'constructor' : member.name,
          sections: member.sections,
          body: member.body,
          hintLine: member.line,
        })
        continue
      }
      if (member.kind !== 'property') continue
      for (const accessor of member.accessors) {
        // A property that names no accessor is a synthesized pass-through pair:
        // it describes itself, so it needs no `### <target>` hint.
        if (accessor.synthesized === true) continue
        if (accessor.body !== null || member.defaultValue !== undefined) continue
        members.push({
          node: accessor,
          name: `${member.name}.${accessor.kind}`,
          sections: accessor.sections,
          body: null,
          hintLine: accessor.line,
        })
      }
    }
  }
  for (const member of members) {
    if (member.body !== null) continue
    for (const target of requested) {
      const hinted = member.sections.some(section => section.lang === target.name)
      if (!hinted) {
        emit('W3010', member.hintLine, `member '${member.name}' has no ts body and no '### ${target.name}' hint`)
      }
    }
  }
}

/**
 * Warn when a `# statement` section has no generation basis for a target
 * (`W3010`, xl-check §3.3, xl-syntax §17).
 *
 * A statement is not symmetric with a member: a member without a ts body still
 * prints an empty body, while a statement without one is a whole segment
 * missing from the ts artifact. So `ts` is checked here too, whenever a ts
 * build is in scope, and a `## <lang>` section (xl-syntax §16) is what covers
 * the other targets.
 * @param {object} doc - parsed document.
 * @param {readonly object[]} targets - resolved target descriptors.
 * @param {Function} emit - diagnostic sink.
 */
function checkStatementHints(doc, targets, emit) {
  for (const decl of doc.decls) {
    if (decl.kind !== 'statement' || decl.body !== null) continue
    // A section with no body and no language section at all is already `E1110`;
    // a hint on top of it would only repeat the same fact.
    if (decl.sections.length === 0) continue
    for (const target of targets) {
      if (target.name === 'ts') {
        emit('W3010', decl.line, 'statement has no ts body, so the ts artifact will not contain it')
        continue
      }
      if (decl.sections.some(section => section.lang === target.name)) continue
      emit('W3010', decl.line, `statement has no ts body and no '## ${target.name}' hint`)
    }
  }
}

/**
 * Warn when a class member carries no prose (`W3102`).
 * @param {object} doc - parsed document.
 * @param {Function} emit - diagnostic sink.
 */
function checkMemberProse(doc, emit) {
  for (const decl of doc.decls) {
    if (decl.kind !== 'class' && decl.kind !== 'interface') continue
    for (const member of decl.members) {
      if (member.prose === '') {
        emit('W3102', member.line, `member "${member.name === '' ? 'constructor' : member.name}" has no description`)
      }
    }
  }
}

/**
 * Warn when a target-language override cites a ts-side dependency without a
 * matching note in `# dependencies` (`W3101`, xl-check §3.3).
 *
 * The check is deliberately narrow: it fires only for names the ts import
 * block actually binds, so an ordinary mention of a standard-library function
 * is not reported.
 * @param {object} doc - parsed document.
 * @param {Function} emit - diagnostic sink.
 */
function checkLanguageSections(doc, emit) {
  const importedNames = new Set()
  for (const block of doc.dependencies?.blocks ?? []) {
    for (const match of block.rawBody.matchAll(/import\s+(?:([A-Za-z_$][\w$]*)|(?:\{([^}]*)\}))\s+from\s+["'][^"']+["']/g)) {
      if (match[1] !== undefined) importedNames.add(match[1])
      for (const part of (match[2] ?? '').split(',')) {
        const piece = part.trim()
        if (piece === '') continue
        const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(piece)
        importedNames.add(alias === null ? piece : alias[1])
      }
    }
  }
  if (importedNames.size === 0) return
  const dependencyLangs = new Set((doc.dependencies?.sections ?? []).map(section => section.lang))
  for (const section of overrideSections(doc)) {
    if (section.lang === 'ts') continue
    if (dependencyLangs.has(section.lang)) continue
    const text = [section.prose, ...section.blocks.map(block => block.rawBody)].join('\n')
    const cited = [...importedNames].filter(name => new RegExp(`\\b${name}\\b`).test(text))
    if (cited.length === 0) continue
    emit('W3101', section.line, `override section "${section.lang}" cites ts-side ${cited.length === 1 ? 'dependency' : 'dependencies'} ${cited.map(name => `"${name}"`).join(', ')} without a matching '## ${section.lang}' note in # dependencies`)
  }
}

/**
 * Every override section in a document, in source order.
 * @param {object} doc - parsed document.
 * @returns {object[]} sections with `lang`, `prose`, `blocks`, and `line`.
 */
export function overrideSections(doc) {
  const sections = []
  const collect = (list) => {
    for (const section of list ?? []) sections.push(section)
  }
  collect(doc.dependencies?.sections)
  collect(doc.namespace?.sections)
  for (const decl of doc.decls) {
    collect(decl.sections)
    for (const member of decl.members ?? []) {
      collect(member.sections)
      for (const accessor of member.accessors ?? []) collect(accessor.sections)
    }
  }
  return sections
}

/**
 * Every language name a document uses in an override section.
 * @param {object} doc - parsed document.
 * @returns {string[]} the language names.
 */
export function languageNamesOf(doc) {
  return overrideSections(doc).map(section => section.lang)
}

/**
 * Warn for each requested non-ts target that the document never mentions
 * (`W3104`).
 * @param {object} doc - parsed document.
 * @param {readonly object[]} targets - resolved target descriptors.
 * @returns {object[]} diagnostics.
 */
export function checkDeclaredTargets(doc, targets) {
  const used = new Set(languageNamesOf(doc))
  const diagnostics = []
  for (const target of targets) {
    if (target.name === 'ts') continue
    if (used.has(target.name)) continue
    diagnostics.push(diag({
      code: 'W3104',
      file: doc.file,
      line: 1,
      msg: `target "${target.name}" has no '## ${target.name}' override section in this file`,
    }))
  }
  return diagnostics
}
