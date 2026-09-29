/**
 * The `*.xl.md` parser: Markdown headings and fenced blocks into the
 * language-neutral IR that the checker, the ts printer, and the non-ts plan
 * channel all read.
 *
 * The parser is pure. It never touches the filesystem: `# dependencies`
 * cross-file references are recorded as raw import records and resolved by the
 * checker, which owns the file port.
 *
 * @module xl/core/parse
 */

import { diag } from './diagnostics.js'
import {
  DEFAULT_LANG,
  isIdentifier,
  indexTopLevel,
  matchPair,
  normalizeCode,
  normalizeNewlines,
  proseOf,
  splitTopLevel,
  stripStringsAndComments,
} from './text.js'
import { parseType } from './types.js'

/** Legal first-level section keywords (xl-syntax §2). */
export const SECTION_KEYWORDS = new Set([
  'dependencies',
  'namespace',
  'type',
  'const',
  'method',
  'enum',
  'interface',
  'class',
  'statement',
])

/** Sections that declare module-level values. They may appear in any order. */
export const MODULE_SECTION_KINDS = new Set(['type', 'const', 'method'])

/** Sections that declare a type. They may appear in any order. */
export const TYPE_SECTION_KINDS = new Set(['enum', 'interface', 'class'])

/** Legal member keywords (xl-syntax §2). */
export const MEMBER_KEYWORDS = new Set(['field', 'property', 'method', 'constructor'])

/** Modifier keywords recognized on declarations and members (xl-syntax §3). */
export const MODIFIER_KEYWORDS = new Set(['public', 'protected', 'private', 'static', 'readonly'])

/** Visibility modifiers, at most one per declaration. */
export const VISIBILITY_KEYWORDS = new Set(['public', 'protected', 'private'])

/**
 * Fence languages recognized as a language section or a target-language block.
 * A heading whose text is not in this set is still a language section when it
 * carries a code block fenced with the same name.
 */
export const LANGUAGE_NAMES = new Set([
  'ts', 'typescript', 'tsx', 'js', 'javascript', 'jsx', 'mjs', 'cjs',
  'csharp', 'cs', 'java', 'kotlin', 'kt', 'scala', 'swift', 'dart',
  'python', 'py', 'go', 'golang', 'rust', 'rs', 'ruby', 'rb', 'php',
  'c', 'cpp', 'c++', 'h', 'hpp', 'objc', 'objective-c',
  'elixir', 'erlang', 'haskell', 'lua', 'perl', 'r', 'julia', 'clojure',
  'fsharp', 'fs', 'vb', 'vbnet', 'groovy', 'nim', 'zig', 'ocaml',
  'sql', 'graphql', 'proto', 'thrift',
  'shell', 'sh', 'bash', 'zsh', 'fish', 'powershell', 'pwsh', 'bat', 'cmd',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'scss',
  'markdown', 'md', 'text', 'txt', 'diff', 'console', 'xl',
])

/** Comment marker per target language, used for the artifact header. */
const LINE_COMMENT_BY_LANG = new Map([
  ['ts', '//'], ['typescript', '//'], ['js', '//'], ['javascript', '//'],
  ['csharp', '//'], ['cs', '//'], ['java', '//'], ['kotlin', '//'], ['kt', '//'],
  ['go', '//'], ['rust', '//'], ['rs', '//'], ['swift', '//'], ['dart', '//'],
  ['scala', '//'], ['cpp', '//'], ['c', '//'], ['c++', '//'],
  ['python', '#'], ['py', '#'], ['ruby', '#'], ['rb', '#'], ['shell', '#'],
  ['sh', '#'], ['bash', '#'], ['yaml', '#'], ['yml', '#'], ['perl', '#'],
  ['r', '#'], ['elixir', '#'], ['toml', '#'], ['powershell', '#'], ['pwsh', '#'],
  ['sql', '--'], ['lua', '--'], ['haskell', '--'],
])

/**
 * Line-comment marker used for an artifact of the given language.
 * @param {string} lang - target language name.
 * @param {string} ext - target file extension, including the dot.
 * @returns {string} the comment marker.
 */
export function commentMarkerFor(lang, ext) {
  return LINE_COMMENT_BY_LANG.get(lang.toLowerCase())
    ?? (ext === '.py' ? '#' : '//')
}

/**
 * Whether a heading name denotes a language section.
 * @param {string} name - heading text.
 * @param {readonly object[]} blocks - code blocks directly under that heading.
 * @returns {boolean} whether the heading is a language section.
 */
function isLanguageSection(name, blocks) {
  if (!isIdentifier(name)) return false
  if (LANGUAGE_NAMES.has(name)) return true
  return blocks.some(block => block.lang === name)
}

/**
 * Parse a `*.xl.md` document into IR plus diagnostics.
 * @param {string} text - the file's decoded text (already validated as UTF-8/LF).
 * @param {string} file - the file's display path, POSIX separators.
 * @returns {{doc: object, diagnostics: object[]}} the IR and its diagnostics.
 */
export function parseXlMd(text, file) {
  const source = normalizeNewlines(text)
  const lines = source.split('\n')
  const ctx = { file, lines, diagnostics: [] }
  const nodes = scanNodes(lines)
  const doc = {
    file,
    lines,
    dependencies: null,
    namespace: null,
    decls: [],
  }

  if (nodes.length === 0) {
    const hasProse = source.trim() !== ''
    emit(ctx, 'E1001', 1, hasProse
      ? 'file has prose but no heading, so it declares nothing'
      : 'file is empty')
    return { doc, diagnostics: ctx.diagnostics }
  }

  let firstSection = true

  for (const node of nodes) {
    const { modifiers, keyword, spec } = splitSectionHeading(node.text)
    if (keyword === 'dependencies') {
      if (!firstSection) {
        emit(ctx, 'E1004', node.line, `# dependencies must be the first section, found it after another section`)
      }
      if (doc.dependencies !== null) {
        emit(ctx, 'E1004', node.line, '# dependencies may appear at most once')
        continue
      }
      doc.dependencies = parseDependencies(node, ctx)
      firstSection = false
      continue
    }
    if (keyword === 'namespace') {
      if (doc.namespace !== null) {
        emit(ctx, 'E1005', node.line, '# namespace may appear at most once')
      } else {
        doc.namespace = parseNamespace(node, ctx, spec)
      }
      firstSection = false
      continue
    }
    if (!SECTION_KEYWORDS.has(keyword)) {
      emit(ctx, 'E1002', node.line, `unknown section keyword "${keyword === '' ? node.text.trim() : keyword}"`)
      firstSection = false
      continue
    }
    firstSection = false
    // Declarations carry no order requirement: a module-level `type` / `const` /
    // `method` may follow an `enum` / `interface` / `class` (xl-syntax §0).
    const decl = parseDeclaration(keyword, node, ctx, spec, modifiers)
    if (decl !== null) doc.decls.push(decl)
  }

  validateDocument(doc, ctx)
  return { doc, diagnostics: ctx.diagnostics }
}

/** Scalar type names whose inline initial values xl can judge without a compiler. */
const NUMERIC_TYPES = new Set(['int', 'float', 'double', 'number'])
const BOOLEAN_TYPES = new Set(['bool', 'boolean'])
const STRING_TYPES = new Set(['string'])

/**
 * Run the whole-document rules that need every declaration: unique top-level
 * names, unique members per type, one constructor per class, and inline
 * initial values that cannot match their declared type.
 * @param {object} doc - the parsed document.
 * @param {object} ctx - parse context.
 */
function validateDocument(doc, ctx) {
  const seenDeclarations = new Map()
  for (const decl of doc.decls) {
    // A `# statement` section is anonymous and declares no symbol, so it can
    // neither collide with another name nor own members (xl-syntax §17).
    if (decl.kind === 'statement') continue
    if (seenDeclarations.has(decl.name)) {
      emit(ctx, 'E1106', decl.line, `"${decl.name}" is declared twice in this file`)
    }
    seenDeclarations.set(decl.name, decl.line)
    if (decl.kind === 'const') checkInitialValue(decl, ctx)
    if (decl.kind !== 'class' && decl.kind !== 'interface') continue
    const seenMembers = new Map()
    let constructors = 0
    for (const member of decl.members) {
      if (member.kind === 'constructor') {
        constructors += 1
        if (constructors > 1) {
          emit(ctx, 'E1206', member.line, `class "${decl.name}" declares more than one constructor`)
        }
        continue
      }
      if (member.kind === 'field') checkInitialValue(member, ctx)
      const previous = seenMembers.get(member.name)
      if (previous === undefined) {
        seenMembers.set(member.name, { line: member.line, arity: member.kind === 'method' ? member.params.length : null })
        continue
      }
      if (member.kind === 'method' && previous.arity !== member.params.length) {
        seenMembers.set(member.name, { line: member.line, arity: member.params.length })
        continue
      }
      emit(ctx, 'E1205', member.line, member.kind === 'method'
        ? `method "${member.name}" is declared twice with ${member.params.length} parameter(s) in "${decl.name}"`
        : `member "${member.name}" is declared twice in "${decl.name}"`)
    }
  }
}

/**
 * Report an inline initial value whose literal shape cannot match the declared
 * scalar type (`E1207`). Types this rule cannot judge are left alone.
 * @param {object} node - a declaration or member with `type` and `defaultValue`.
 * @param {object} ctx - parse context.
 */
function checkInitialValue(node, ctx) {
  if (node.defaultValue === undefined || node.type === null) return
  const name = node.type.name
  if (name === undefined) return
  const value = node.defaultValue.trim()
  if (NUMERIC_TYPES.has(name) && !/^-?\d+(?:\.\d+)?$/.test(value)) {
    emit(ctx, 'E1207', node.line, `initial value ${value} does not match declared type "${name}"`)
    return
  }
  if (BOOLEAN_TYPES.has(name) && value !== 'true' && value !== 'false') {
    emit(ctx, 'E1207', node.line, `initial value ${value} does not match declared type "${name}"`)
    return
  }
  if (STRING_TYPES.has(name) && !/^["'`]/.test(value)) {
    emit(ctx, 'E1207', node.line, `initial value ${value} does not match declared type "${name}"`)
  }
}

/**
 * Split a first-level heading into its leading visibility modifiers, its
 * section keyword, and the specification that follows (xl-syntax §3).
 * @param {string} text - heading text without the `#` markers.
 * @returns {{modifiers: string[], keyword: string, spec: string}} the parts.
 */
function splitSectionHeading(text) {
  const modifiers = []
  let rest = text.trim()
  for (;;) {
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+/.exec(rest)
    if (match === null || !MODIFIER_KEYWORDS.has(match[1])) break
    modifiers.push(match[1])
    rest = rest.slice(match[0].length)
  }
  const keywordMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*/.exec(rest)
  if (keywordMatch === null) return { modifiers, keyword: '', spec: '' }
  return { modifiers, keyword: keywordMatch[1], spec: rest.slice(keywordMatch[0].length).trim() }
}

/**
 * Append a diagnostic to a parse context.
 * @param {object} ctx - parse context.
 * @param {string} code - rule code.
 * @param {number} line - 1-based source line.
 * @param {string} msg - message text.
 * @param {object} [extra] - optional `col`, `endLine`, `endCol`, `help`.
 */
function emit(ctx, code, line, msg, extra = {}) {
  ctx.diagnostics.push(diag({ code, file: ctx.file, line, msg, ...extra }))
}

/**
 * Collect heading nodes and the body lines each one owns.
 *
 * Headings inside a fenced block are literal content, not structure, so fence
 * state is tracked across the whole scan.
 * @param {readonly string[]} lines - source lines.
 * @returns {object[]} heading nodes in source order, each with `bodyLines`.
 */
function scanNodes(lines) {
  const nodes = []
  let fence = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (fence) {
      if (/^\s*```/.test(line)) fence = false
      continue
    }
    if (/^\s*```/.test(line)) {
      fence = true
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (heading === null) continue
    nodes.push({
      level: heading[1].length,
      text: heading[2],
      line: index + 1,
      col: heading[1].length + 2,
      bodyLines: [],
      children: [],
    })
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const end = index + 1 < nodes.length ? nodes[index + 1].line - 1 : lines.length
    nodes[index].bodyLines = lines.slice(nodes[index].line, end)
  }
  const root = { level: 0, text: '', line: 0, bodyLines: [], children: [] }
  const stack = [root]
  for (const node of nodes) {
    while (stack.length > 1 && stack[stack.length - 1].level >= node.level) stack.pop()
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return root.children
}

/**
 * Extract fenced code blocks from body lines.
 * @param {readonly string[]} bodyLines - lines owned by one heading.
 * @param {number} startLine - 1-based line number of `bodyLines[0]`.
 * @returns {object[]} code blocks with `lang`, `rawBody`, `line`, `endLine`, `closed`.
 */
function codeBlocks(bodyLines, startLine) {
  const blocks = []
  let open = null
  for (let index = 0; index < bodyLines.length; index += 1) {
    const line = bodyLines[index]
    const fence = /^(\s*)```(.*)$/.exec(line)
    if (open === null) {
      if (fence === null) continue
      open = {
        lang: fence[2].trim(),
        line: startLine + index,
        col: fence[1].length + 1,
        body: [],
      }
      continue
    }
    if (/^\s*```\s*$/.test(line)) {
      blocks.push({
        lang: open.lang,
        rawBody: open.body.join('\n'),
        line: open.line,
        col: open.col,
        endLine: startLine + index,
        closed: true,
      })
      open = null
      continue
    }
    open.body.push(line)
  }
  if (open !== null) {
    blocks.push({
      lang: open.lang,
      rawBody: open.body.join('\n'),
      line: open.line,
      col: open.col,
      endLine: startLine + open.body.length,
      closed: false,
    })
  }
  return blocks
}

/**
 * Build the language sections declared by a heading's children.
 * @param {object} node - the owning heading.
 * @param {object} ctx - parse context.
 * @param {Set<string>} [taken] - child names already claimed by other roles.
 * @returns {object[]} language sections with `lang`, `prose`, `blocks`, `line`.
 */
function languageSections(node, ctx, taken = new Set()) {
  const sections = []
  const seen = new Set()
  for (const child of node.children) {
    const name = child.text.trim()
    if (taken.has(name)) continue
    const blocks = codeBlocks(child.bodyLines, child.line + 1)
    if (!isLanguageSection(name, blocks)) {
      emit(ctx, 'E1305', child.line, `unknown sub-heading "${name}": expected get, set, or a language name`)
      continue
    }
    if (seen.has(name)) {
      emit(ctx, 'E1303', child.line, `language section "${name}" is declared twice under one heading`)
      continue
    }
    seen.add(name)
    sections.push({
      lang: name,
      prose: proseOf(child.bodyLines),
      blocks,
      line: child.line,
    })
  }
  return sections
}

/**
 * Split a section's own code blocks into the default-language block and any
 * misplaced ones, reporting `E1302`/`E1301`/`E1303`.
 * @param {object} node - the owning heading.
 * @param {object} ctx - parse context.
 * @param {object} [options] - `allowXl` accepts an `xl` fence; `many` accepts repeated default blocks.
 * @returns {{blocks: object[], block: object | null, xlBlocks: object[]}} default blocks.
 */
function defaultBlocks(node, ctx, options = {}) {
  const blocks = codeBlocks(node.bodyLines, node.line + 1)
  const accepted = []
  const xlBlocks = []
  for (const block of blocks) {
    if (block.lang === 'xl') {
      if (options.allowXl === true) {
        xlBlocks.push(block)
        continue
      }
      emit(ctx, 'E1302', block.line, `fence language "xl" is only valid in # dependencies`, {
        col: block.col, endCol: block.col + 3,
      })
      continue
    }
    if (block.lang !== DEFAULT_LANG) {
      emit(ctx, 'E1302', block.line, `default body must use the default language '${DEFAULT_LANG}', got '${block.lang}'`, {
        col: block.col, endCol: block.col + 3 + block.lang.length,
      })
      continue
    }
    if (accepted.length > 0 && options.many !== true) {
      emit(ctx, 'E1301', block.line, 'a member may declare at most one default-language block', {
        col: block.col, endCol: block.col + 5,
      })
      continue
    }
    accepted.push(block)
  }
  return { blocks: accepted, block: accepted[0] ?? null, xlBlocks }
}

/**
 * Report a code block that has no content (`W3012`).
 * @param {readonly object[]} blocks - code blocks to inspect.
 * @param {object} ctx - parse context.
 */
function warnEmptyBlocks(blocks, ctx) {
  for (const block of blocks) {
    if (block.rawBody.trim() === '') {
      emit(ctx, 'W3012', block.line, 'code block is empty', {
        col: block.col, endCol: block.col + 3 + block.lang.length,
      })
    }
  }
}

/**
 * Report a language section that carries prose only (`W3011`).
 * @param {readonly object[]} sections - language sections.
 * @param {object} ctx - parse context.
 */
function warnProseOnlySections(sections, ctx) {
  for (const section of sections) {
    if (section.blocks.length === 0 && section.prose !== '') {
      emit(ctx, 'W3011', section.line, `language section "${section.lang}" has prose but no code block`)
    }
  }
}

/**
 * Parse `# dependencies`.
 * @param {object} node - the section heading.
 * @param {object} ctx - parse context.
 * @returns {object} the dependency section.
 */
function parseDependencies(node, ctx) {
  const taken = new Set()
  const sections = languageSections(node, ctx, taken)
  const { blocks, xlBlocks } = defaultBlocks(node, ctx, { allowXl: true, many: true })
  warnEmptyBlocks(blocks, ctx)
  warnProseOnlySections(sections, ctx)
  const imports = []
  for (const block of xlBlocks) {
    const blockLines = block.rawBody.split('\n')
    for (let index = 0; index < blockLines.length; index += 1) {
      const raw = blockLines[index].trim()
      if (raw === '') continue
      const line = block.line + 1 + index
      const parsed = parseImportLine(raw)
      if (parsed === null) {
        emit(ctx, 'E1006', line, `dependency line must be: import { name } from "./x.xl.md"`)
        continue
      }
      if (!parsed.from.startsWith('./') && !parsed.from.startsWith('../')) {
        emit(ctx, 'E1006', line, `dependency target "${parsed.from}" must be a relative path`)
        continue
      }
      if (!parsed.from.endsWith('.xl.md')) {
        emit(ctx, 'E1006', line, `dependency target "${parsed.from}" must end with .xl.md`)
        continue
      }
      imports.push({ ...parsed, line, raw })
    }
  }
  return {
    line: node.line,
    prose: proseOf(node.bodyLines),
    blocks,
    xlBlocks,
    imports,
    sections,
  }
}

/**
 * Parse one `import { a, b as c } from "./x.xl.md"` line.
 * @param {string} raw - trimmed line.
 * @returns {{names: object[], from: string} | null} the parsed import, or `null`.
 */
export function parseImportLine(raw) {
  const match = /^import\s+(?:type\s+)?\{\s*([^}]*)\}\s*from\s*["']([^"']+)["'];?$/.exec(raw)
  if (match === null) return null
  const names = splitTopLevel(match[1]).map((part) => {
    const alias = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(part)
    if (alias !== null) return { name: alias[1], alias: alias[2] }
    return { name: part, alias: null }
  })
  if (names.length === 0 || names.some(entry => !isIdentifier(entry.name))) return null
  return { names, from: match[2] }
}

/**
 * Parse `# namespace <name>`.
 * @param {object} node - the section heading.
 * @param {object} ctx - parse context.
 * @param {string} spec - heading text after the keyword.
 * @returns {object} the namespace section.
 */
function parseNamespace(node, ctx, spec) {
  const taken = new Set()
  const sections = languageSections(node, ctx, taken)
  const name = spec.trim()
  if (!isIdentifier(name)) {
    emit(ctx, 'E1003', node.line, name === ''
      ? '# namespace requires a name'
      : `# namespace name "${name}" is not an identifier`)
  }
  const prose = proseOf(node.bodyLines)
  if (prose === '') emit(ctx, 'W3103', node.line, '# namespace has no description')
  warnProseOnlySections(sections, ctx)
  return { line: node.line, name, prose, sections }
}

/**
 * Parse one first-level declaration.
 * @param {string} kind - section keyword.
 * @param {object} node - the section heading.
 * @param {object} ctx - parse context.
 * @param {string} spec - heading text after the keyword.
 * @param {readonly string[]} modifiers - visibility modifiers written before the keyword.
 * @returns {object | null} the declaration, or `null` when the heading is unusable.
 */
function parseDeclaration(kind, node, ctx, spec, modifiers) {
  if (kind === 'statement') {
    for (const modifier of modifiers) {
      emit(ctx, 'E1202', node.line, `modifier '${modifier}' is not valid on # statement`)
    }
    return parseStatementDecl(node, ctx, spec)
  }
  if (modifiers.length > 0) {
    const visibility = modifiers.filter(modifier => VISIBILITY_KEYWORDS.has(modifier))
    if (visibility.length > 1) {
      emit(ctx, 'E1211', node.line, `at most one visibility modifier is allowed, got ${visibility.join(', ')}`)
    }
    for (const forbidden of ['static', 'readonly']) {
      if (modifiers.includes(forbidden)) {
        emit(ctx, 'E1202', node.line, `modifier '${forbidden}' is not valid on a top-level declaration`)
      }
    }
    if (modifiers.includes('protected')) {
      emit(ctx, 'E1202', node.line, "modifier 'protected' is not valid on a top-level declaration")
    }
  }
  switch (kind) {
    case 'type':
      return parseTypeDecl(node, ctx, spec, modifiers)
    case 'const':
      return parseConstDecl(node, ctx, spec, modifiers)
    case 'method':
      return parseMethodDecl(node, ctx, spec, modifiers)
    case 'enum':
      return parseEnumDecl(node, ctx, spec, modifiers)
    case 'interface':
      return parseInterfaceDecl(node, ctx, spec, modifiers)
    case 'class':
      return parseClassDecl(node, ctx, spec, modifiers)
    default:
      return null
  }
}

/**
 * Shared shell of a declaration, filled in by each keyword's parser.
 * @param {string} kind - declaration kind.
 * @param {object} node - the section heading.
 * @returns {object} an empty declaration.
 */
function emptyDecl(kind, node) {
  return {
    kind,
    name: '',
    modifiers: [],
    typeParams: [],
    extends: null,
    implements: [],
    typeText: null,
    type: null,
    optional: false,
    defaultValue: undefined,
    typeTextRaw: null,
    body: null,
    cases: [],
    members: [],
    sections: [],
    prose: '',
    line: node.line,
  }
}

/**
 * Parse `# type <Name> = <原文>` (xl-syntax §6).
 * @param {object} node - the section heading.
 * @param {object} ctx - parse context.
 * @param {string} spec - heading text after the keyword.
 * @param {readonly string[]} modifiers - visibility modifiers.
 * @returns {object} the declaration.
 */
function parseTypeDecl(node, ctx, spec, modifiers) {
  const decl = emptyDecl('type', node)
  decl.modifiers = [...modifiers]
  const eq = indexAssign(spec)
  if (eq < 0) {
    emit(ctx, 'E1108', node.line, '# type requires "= <原文>"')
    decl.name = spec.split(/\s+/)[0] ?? ''
    if (!isIdentifier(decl.name)) emit(ctx, 'E1101', node.line, `# type name "${decl.name}" is not an identifier`)
    return decl
  }
  decl.name = spec.slice(0, eq).trim()
  decl.typeTextRaw = spec.slice(eq + 1).trim()
  if (!isIdentifier(decl.name)) {
    emit(ctx, 'E1101', node.line, `# type name "${decl.name}" is not an identifier`)
  }
  if (decl.typeTextRaw === '') emit(ctx, 'E1108', node.line, '# type requires "= <原文>"')
  decl.prose = proseOf(node.bodyLines)
  decl.sections = languageSections(node, ctx)
  warnProseOnlySections(decl.sections, ctx)
  return decl
}

/**
 * Parse `# const <NAME>:<Type> [= <初始值>]` (xl-syntax §7).
 * @param {object} node - the section heading.
 * @param {object} ctx - parse context.
 * @param {string} spec - heading text after the keyword.
 * @param {readonly string[]} modifiers - visibility modifiers.
 * @returns {object} the declaration.
 */
function parseConstDecl(node, ctx, spec, modifiers) {
  const decl = emptyDecl('const', node)
  decl.modifiers = [...modifiers]
  const { name, typeText, init } = splitTypedName(spec)
  decl.name = name
  decl.typeText = typeText
  decl.type = checkType(typeText, ctx, node.line, decl)
  if (init !== undefined) decl.defaultValue = init
  if (!isIdentifier(decl.name)) {
    emit(ctx, 'E1203', node.line, `# const name "${decl.name}" is not an identifier`)
  }
  decl.prose = proseOf(node.bodyLines)
  const { block } = defaultBlocks(node, ctx)
  decl.body = block
  if (block !== null) warnEmptyBlocks([block], ctx)
  decl.sections = languageSections(node, ctx)
  warnProseOnlySections(decl.sections, ctx)
  return decl
}

/**
 * Parse a module-level `# method` (xl-syntax §8).
 * @param {object} node - the section heading.
 * @param {object} ctx - parse context.
 * @param {string} spec - heading text after the keyword.
 * @param {readonly string[]} modifiers - visibility modifiers.
 * @returns {object} the declaration.
 */
function parseMethodDecl(node, ctx, spec, modifiers) {
  const decl = emptyDecl('method', node)
  decl.modifiers = [...modifiers]
  const member = parseMethodSpec(spec, node, ctx)
  Object.assign(decl, member)
  decl.kind = 'method'
  decl.prose = proseOf(node.bodyLines)
  const { block } = defaultBlocks(node, ctx)
  decl.body = block
  if (block !== null) warnEmptyBlocks([block], ctx)
  if (decl.async) {
    for (const forbidden of ['static', 'readonly']) {
      if (modifiers.includes(forbidden)) {
        emit(ctx, 'E1202', node.line, `modifier '${forbidden}' is not valid on a module-level method`)
      }
    }
  }
  decl.sections = languageSections(node, ctx)
  warnProseOnlySections(decl.sections, ctx)
  return decl
}

/** A line that ts hoists to the top of the artifact, ahead of its header. */
const HOISTED_STATEMENT_LINE = /^import(?=[\s{*'"])|^export(?=[\s{*])[^;]*\bfrom\b/

/**
 * Report a static top-level `import` (or a re-`export`) inside a `# statement`
 * body (`W3013`, xl-check §3.3).
 *
 * The body is copied into the artifact verbatim, but ts hoists a static import
 * to the top of the file, ahead of the `@generated by xl` header — which is how
 * a statement section silently breaks the "first line is the header" invariant.
 * Dependencies belong in `# dependencies` (xl-syntax §4).
 * @param {object} block - the statement's default-language code block.
 * @param {object} ctx - parse context.
 */
function warnHoistedImports(block, ctx) {
  const body = normalizeCode(block.rawBody)
  if (body === '') return
  const lines = stripStringsAndComments(body).split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || !HOISTED_STATEMENT_LINE.test(line)) continue
    emit(ctx, 'W3013', block.line, 'a static import inside # statement is hoisted ahead of the artifact header', {
      col: block.col, endCol: block.col + 3 + block.lang.length,
    })
    return
  }
}

/**
 * Parse `# statement` (xl-syntax §17): an anonymous module-level statement
 * section. It declares no name and no symbol, so it takes no modifiers, never
 * produces an `export`, and never appears in the export or type-name sets.
 * @param {object} node - the section heading.
 * @param {object} ctx - parse context.
 * @param {string} spec - heading text after the keyword.
 * @returns {object} the declaration.
 */
function parseStatementDecl(node, ctx, spec) {
  const decl = emptyDecl('statement', node)
  if (spec.trim() !== '') {
    emit(ctx, 'E1203', node.line, `# statement takes no name, got "${spec.trim()}"`)
  }
  decl.prose = proseOf(node.bodyLines)
  const { block } = defaultBlocks(node, ctx)
  decl.body = block
  if (block !== null) {
    warnEmptyBlocks([block], ctx)
    warnHoistedImports(block, ctx)
  }
  decl.sections = languageSections(node, ctx)
  warnProseOnlySections(decl.sections, ctx)
  const hasDefault = block !== null && normalizeCode(block.rawBody) !== ''
  const hasHint = decl.sections.some(
    section => section.blocks.some(item => normalizeCode(item.rawBody) !== ''),
  )
  if (!hasDefault && !hasHint) {
    emit(ctx, 'E1110', node.line, '# statement has no default-language body and no "## <lang>" section')
  }
  return decl
}

/**
 * Parse `# enum <name>` with its `- case` members (xl-syntax §9).
 * @param {object} node - the section heading.
 * @param {object} ctx - parse context.
 * @param {string} spec - heading text after the keyword.
 * @param {readonly string[]} modifiers - visibility modifiers.
 * @returns {object} the declaration.
 */
function parseEnumDecl(node, ctx, spec, modifiers) {
  const decl = emptyDecl('enum', node)
  decl.modifiers = [...modifiers]
  decl.name = spec.trim()
  if (!isIdentifier(decl.name)) {
    emit(ctx, 'E1101', node.line, decl.name === ''
      ? '# enum requires a name'
      : `# enum name "${decl.name}" is not an identifier`)
  }
  decl.prose = proseOf(node.bodyLines)
  const seen = new Set()
  for (let index = 0; index < node.bodyLines.length; index += 1) {
    const raw = node.bodyLines[index]
    const line = node.line + 1 + index
    const trimmed = raw.trim()
    if (!trimmed.startsWith('-')) continue
    const match = /^-\s*case\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=\s*(.+?))?\s*$/.exec(trimmed)
    if (match === null) {
      emit(ctx, 'E1212', line, 'enum member must be written "- case <name>" or "- case <name> = <原文>"')
      continue
    }
    const name = match[1]
    if (seen.has(name)) {
      emit(ctx, 'E1109', line, `enum member "${name}" is declared twice`)
      continue
    }
    seen.add(name)
    decl.cases.push({ name, value: match[2] === undefined ? null : match[2].trim(), line })
  }
  if (decl.cases.length === 0) {
    emit(ctx, 'E1109', node.line, '# enum declares no "- case <name>" member')
  }
  decl.sections = languageSections(node, ctx)
  warnProseOnlySections(decl.sections, ctx)
  return decl
}

/**
 * Parse `# interface <name> [extends <Base>]` and its members (xl-syntax §10).
 * @param {object} node - the section heading.
 * @param {object} ctx - parse context.
 * @param {string} spec - heading text after the keyword.
 * @param {readonly string[]} modifiers - visibility modifiers.
 * @returns {object} the declaration.
 */
function parseInterfaceDecl(node, ctx, spec, modifiers) {
  const decl = emptyDecl('interface', node)
  decl.modifiers = [...modifiers]
  const parsed = parseTypeHeader(spec, ctx, node.line, { allowGenerics: true })
  decl.name = parsed.name
  decl.typeParams = parsed.typeParams
  decl.extends = parsed.extends
  if (parsed.implements.length > 0) {
    emit(ctx, 'E1102', node.line, '# interface must not declare "implements"')
  }
  decl.prose = proseOf(node.bodyLines)
  decl.members = parseMembers(node, ctx, { owner: 'interface', ownerName: decl.name })
  return decl
}

/**
 * Parse `# class <name>[<T>] [extends Base] [implements I1, I2]` and its members.
 * @param {object} node - the section heading.
 * @param {object} ctx - parse context.
 * @param {string} spec - heading text after the keyword.
 * @param {readonly string[]} modifiers - visibility modifiers.
 * @returns {object} the declaration.
 */
function parseClassDecl(node, ctx, spec, modifiers) {
  const decl = emptyDecl('class', node)
  decl.modifiers = [...modifiers]
  const parsed = parseTypeHeader(spec, ctx, node.line, { allowGenerics: true })
  decl.name = parsed.name
  decl.typeParams = parsed.typeParams
  decl.extends = parsed.extends
  decl.implements = parsed.implements
  decl.prose = proseOf(node.bodyLines)
  decl.members = parseMembers(node, ctx, { owner: 'class', ownerName: decl.name })
  return decl
}

/**
 * Parse a class or interface header.
 * @param {string} spec - heading text after the keyword.
 * @param {object} ctx - parse context.
 * @param {number} line - heading line.
 * @param {object} options - `allowGenerics` accepts a type-parameter list.
 * @returns {object} the parsed header.
 */
function parseTypeHeader(spec, ctx, line, options) {
  const out = { name: '', modifiers: [], typeParams: [], extends: null, implements: [] }
  let rest = spec
  for (;;) {
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+/.exec(rest)
    if (match === null || !MODIFIER_KEYWORDS.has(match[1])) break
    out.modifiers.push(match[1])
    rest = rest.slice(match[0].length)
  }
  const nameMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(rest)
  if (nameMatch === null) {
    emit(ctx, 'E1101', line, `declaration requires a name`)
    return out
  }
  out.name = nameMatch[1]
  rest = rest.slice(nameMatch[0].length)
  if (rest.startsWith('<')) {
    const end = matchPair(rest, 0)
    if (end < 0) {
      emit(ctx, 'E1103', line, 'unbalanced generic parameter list')
      return out
    }
    if (options.allowGenerics !== true) {
      emit(ctx, 'E1103', line, 'an interface declares no generic parameters')
    } else {
      out.typeParams = parseTypeParams(rest.slice(1, end - 1), ctx, line)
    }
    rest = rest.slice(end)
  }
  rest = rest.trim()
  const extendsIndex = /\bextends\b/.exec(rest)
  if (extendsIndex !== null) {
    const afterExtends = rest.slice(extendsIndex.index + extendsIndex[0].length)
    const implementsMatch = /\bimplements\b/.exec(afterExtends)
    const base = (implementsMatch === null ? afterExtends : afterExtends.slice(0, implementsMatch.index)).trim()
    out.extends = base === '' ? null : base
    if (out.extends === null) emit(ctx, 'E1104', line, '"extends" requires a base type')
    rest = implementsMatch === null ? '' : afterExtends.slice(implementsMatch.index)
  }
  const implementsMatch = /\bimplements\b/.exec(rest)
  if (implementsMatch !== null) {
    const list = rest.slice(implementsMatch.index + implementsMatch[0].length).trim()
    if (list === '') emit(ctx, 'E1105', line, '"implements" requires at least one interface')
    out.implements = splitTopLevel(list).map(name => name.trim()).filter(name => name !== '')
  }
  return out
}

/**
 * Parse a `<T extends X, V = any>` parameter list.
 * @param {string} body - text between the angle brackets.
 * @param {object} ctx - parse context.
 * @param {number} line - heading line.
 * @returns {object[]} type parameters.
 */
function parseTypeParams(body, ctx, line) {
  const params = []
  for (const part of splitTopLevel(body)) {
    const nameMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(part)
    if (nameMatch === null) {
      emit(ctx, 'E1103', line, `generic parameter "${part}" is not of the form <T extends X, V = any>`)
      continue
    }
    let rest = part.slice(nameMatch[0].length).trim()
    let constraint = null
    let fallback = null
    const extendsMatch = /^extends\b/.exec(rest)
    if (extendsMatch !== null) {
      rest = rest.slice(extendsMatch[0].length).trim()
      const eq = indexAssign(rest)
      constraint = (eq < 0 ? rest : rest.slice(0, eq)).trim()
      rest = eq < 0 ? '' : rest.slice(eq + 1).trim()
      if (constraint === '') {
        emit(ctx, 'E1103', line, `generic parameter "${nameMatch[1]}" has an empty constraint`)
        constraint = null
      }
    }
    if (rest.startsWith('=')) {
      fallback = rest.slice(1).trim()
      rest = ''
      if (fallback === '') {
        emit(ctx, 'E1103', line, `generic parameter "${nameMatch[1]}" has an empty default`)
        fallback = null
      }
    }
    if (rest !== '') {
      emit(ctx, 'E1103', line, `generic parameter "${part}" is not of the form <T extends X, V = any>`)
    }
    params.push({ name: nameMatch[1], constraint, default: fallback })
  }
  return params
}

/**
 * Parse every `## member` heading under a class or interface.
 * @param {object} node - the declaration heading.
 * @param {object} ctx - parse context.
 * @param {object} owner - `owner` (`class`/`interface`) and `ownerName`.
 * @returns {object[]} members.
 */
function parseMembers(node, ctx, owner) {
  const members = []
  for (const child of node.children) {
    const member = parseMember(child, ctx, owner)
    if (member === null) continue
    members.push(member)
  }
  return members
}

/**
 * Parse one `## member` heading.
 * @param {object} node - the member heading.
 * @param {object} ctx - parse context.
 * @param {object} owner - `owner` (`class`/`interface`) and `ownerName`.
 * @returns {object | null} the member, or `null` when the heading declares none.
 */
function parseMember(node, ctx, owner) {
  const text = node.text.trim()
  const modifiers = []
  let rest = text
  for (;;) {
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+/.exec(rest)
    if (match === null || !MODIFIER_KEYWORDS.has(match[1])) break
    modifiers.push(match[1])
    rest = rest.slice(match[0].length)
  }
  const kindMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(rest)
  const kind = kindMatch === null ? '' : kindMatch[1]
  if (!MEMBER_KEYWORDS.has(kind)) {
    emit(ctx, 'E1201', node.line, `unknown member kind "${kind === '' ? text : kind}"`, {
      col: node.col, endCol: node.col + text.length,
    })
    return null
  }
  const spec = rest.slice(kindMatch[0].length).trim()
  checkVisibility(modifiers, node, ctx)
  const member = {
    kind,
    name: '',
    modifiers,
    typeParams: [],
    params: [],
    returns: null,
    returnsText: 'void',
    async: false,
    optional: false,
    type: null,
    typeText: null,
    defaultValue: undefined,
    body: null,
    accessors: [],
    sections: [],
    prose: proseOf(node.bodyLines),
    line: node.line,
  }

  if (kind === 'constructor') {
    if (owner.owner === 'interface') {
      emit(ctx, 'E1102', node.line, 'an interface declares no constructor')
    }
    checkConstructorModifiers(modifiers, node, ctx)
    parseConstructorTail(spec, member, node, ctx)
  } else if (kind === 'field') {
    const { name, optional, typeText, init } = splitTypedName(spec, { allowOptional: true })
    member.name = name
    member.optional = optional
    member.typeText = typeText
    member.type = checkType(typeText, ctx, node.line, member)
    if (init !== undefined) member.defaultValue = init
    if (!isIdentifier(member.name)) emit(ctx, 'E1203', node.line, `member name "${member.name}" is not an identifier`)
    const { block } = defaultBlocks(node, ctx)
    member.body = block
    if (block !== null) warnEmptyBlocks([block], ctx)
  } else if (kind === 'property') {
    checkPropertyModifiers(modifiers, node, ctx)
    const { name, typeText, init } = splitTypedName(spec)
    member.name = name
    member.typeText = typeText
    member.type = checkType(typeText, ctx, node.line, member)
    if (init !== undefined) member.defaultValue = init
    if (!isIdentifier(member.name)) emit(ctx, 'E1203', node.line, `member name "${member.name}" is not an identifier`)
  } else {
    const parsed = parseMethodSpec(spec, node, ctx)
    Object.assign(member, parsed)
  }

  if (owner.owner === 'interface' && kind !== 'field' && kind !== 'method' && kind !== 'property') {
    emit(ctx, 'E1102', node.line, `an interface member must be a field, a property, or a method, got "${kind}"`)
  }

  if (kind === 'method' || kind === 'constructor') {
    const { block } = defaultBlocks(node, ctx)
    member.body = block
    if (block !== null) warnEmptyBlocks([block], ctx)
  }

  collectMemberChildren(node, member, ctx, owner)
  return member
}

/**
 * Parse a property's accessors and every member's language sections.
 * @param {object} node - the member heading.
 * @param {object} member - the member being filled in.
 * @param {object} ctx - parse context.
 * @param {object} owner - `owner` (`class`/`interface`) and `ownerName`.
 */
function collectMemberChildren(node, member, ctx, owner) {
  /** @type {Set<string>} */
  const taken = new Set()
  if (member.kind === 'property') {
    for (const child of node.children) {
      const name = child.text.trim()
      const modifiers = []
      let rest = name
      for (;;) {
        const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+/.exec(rest)
        if (match === null || !MODIFIER_KEYWORDS.has(match[1])) break
        modifiers.push(match[1])
        rest = rest.slice(match[0].length)
      }
      if (rest !== 'get' && rest !== 'set') continue
      taken.add(name)
      const { block } = defaultBlocks(child, ctx)
      if (block !== null) warnEmptyBlocks([block], ctx)
      const accessor = {
        kind: rest,
        modifiers,
        body: block,
        sections: languageSections(child, ctx),
        line: child.line,
      }
      warnProseOnlySections(accessor.sections, ctx)
      member.accessors.push(accessor)
    }
    const getters = member.accessors.filter(accessor => accessor.kind === 'get')
    const setters = member.accessors.filter(accessor => accessor.kind === 'set')
    if (getters.length > 1 || setters.length > 1) {
      emit(ctx, 'E1210', node.line, `property "${member.name}" declares an accessor twice`)
    }
    if (member.accessors.length === 0) {
      // A property that names no accessor means "both are supported": the
      // synthesized pair behaves exactly like two empty `### get` / `### set`
      // markers (xl-syntax §14). The marker keeps `W3010` from treating it as a
      // member without a generation basis — a pass-through property describes
      // itself.
      member.accessors.push(
        { kind: 'get', modifiers: [], body: null, sections: [], line: node.line, synthesized: true },
        { kind: 'set', modifiers: [], body: null, sections: [], line: node.line, synthesized: true },
      )
    } else {
      // `get` before `set` is the emitted order, not a source requirement.
      member.accessors.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'get' ? -1 : 1))
    }
  } else {
    for (const child of node.children) {
      const name = child.text.trim()
      if (name === 'get' || name === 'set') {
        emit(ctx, 'E1209', node.line, `"### ${name}" is only valid under a property, not under "${member.kind}"`)
        taken.add(name)
      }
    }
  }
  const seenLanguages = new Set()
  for (const child of node.children) {
    const name = child.text.trim()
    if (taken.has(name)) continue
    const blocks = codeBlocks(child.bodyLines, child.line + 1)
    if (!isLanguageSection(name, blocks)) {
      emit(ctx, 'E1305', child.line, `unknown sub-heading "${name}": expected get, set, or a language name`)
      continue
    }
    if (seenLanguages.has(name)) {
      emit(ctx, 'E1303', child.line, `language section "${name}" is declared twice under one heading`)
      continue
    }
    seenLanguages.add(name)
    const section = { lang: name, prose: proseOf(child.bodyLines), blocks, line: child.line }
    member.sections.push(section)
    if (section.blocks.length === 0 && section.prose !== '') {
      emit(ctx, 'W3011', child.line, `language section "${name}" has prose but no code block`)
    }
  }
  if (member.kind === 'constructor' && member.body !== null && owner.owner === 'interface') {
    emit(ctx, 'E1304', node.line, 'an interface member must not carry a body')
  }
  for (const block of [member.body, ...member.accessors.map(accessor => accessor.body)]) {
    if (block === null || block === undefined) continue
    if (owner.owner === 'interface') {
      emit(ctx, 'E1304', node.line, `an interface member must not carry a body`, {
        col: block.col, endCol: block.col + 3 + block.lang.length,
      })
    }
  }
  if (owner.owner === 'interface' && member.defaultValue !== undefined) {
    emit(ctx, 'E1102', node.line, `an interface member must not carry an initial value`)
  }
}

/**
 * Parse a `file`/`property`/`const` specification of the form
 * `<name>[?]:<Type>[ = <初始值>]`.
 * @param {string} spec - specification text.
 * @param {object} [options] - `allowOptional` accepts `name?`.
 * @returns {{name: string, optional: boolean, typeText: string, init: string | undefined}} the parts.
 */
function splitTypedName(spec, options = {}) {
  const colon = indexTopLevel(spec, ':')
  if (colon < 0) return { name: spec.trim(), optional: false, typeText: '', init: undefined }
  let head = spec.slice(0, colon).trim()
  const optional = head.endsWith('?')
  if (optional && options.allowOptional !== true) {
    // Kept as a name suffix; the caller reports the position error.
  }
  if (optional) head = head.slice(0, -1).trim()
  let typeText = spec.slice(colon + 1)
  let init
  const eq = indexAssign(typeText)
  if (eq >= 0) {
    init = typeText.slice(eq + 1).trim()
    typeText = typeText.slice(0, eq)
  }
  return { name: head, optional, typeText: typeText.trim(), init }
}

/**
 * Parse a method specification `[async ][<T>](<params>)=><返回>`.
 * @param {string} spec - specification text after the `method` keyword.
 * @param {object} node - the member heading.
 * @param {object} ctx - parse context.
 * @returns {object} member fields (`name`, `typeParams`, `params`, `returns`, `async`).
 */
function parseMethodSpec(spec, node, ctx) {
  const out = {
    name: '',
    typeParams: [],
    params: [],
    returns: null,
    returnsText: 'void',
    async: false,
  }
  const colon = indexTopLevel(spec, ':')
  if (colon < 0) {
    emit(ctx, 'E1204', node.line, `method "${spec}" must be written <name>:<T>(<参数>)=><返回类型>`)
    out.name = spec.split(/[<(]/)[0].trim()
    return out
  }
  out.name = spec.slice(0, colon).trim()
  if (!isIdentifier(out.name)) emit(ctx, 'E1203', node.line, `method name "${out.name}" is not an identifier`)
  let rest = spec.slice(colon + 1).trim()
  if (/^async\b/.test(rest)) {
    out.async = true
    rest = rest.replace(/^async\b/, '').trim()
  }
  if (rest.startsWith('<')) {
    const end = matchPair(rest, 0)
    if (end < 0) {
      emit(ctx, 'E1103', node.line, 'unbalanced generic parameter list')
      return out
    }
    out.typeParams = parseTypeParams(rest.slice(1, end - 1), ctx, node.line)
    rest = rest.slice(end).trim()
    if (/^async\b/.test(rest)) {
      out.async = true
      rest = rest.replace(/^async\b/, '').trim()
    }
  }
  if (!rest.startsWith('(')) {
    emit(ctx, 'E1208', node.line, `method "${out.name}" requires a parameter list`)
    return out
  }
  const end = matchPair(rest, 0)
  if (end < 0) {
    emit(ctx, 'E1208', node.line, `method "${out.name}" has an unbalanced parameter list`)
    return out
  }
  out.params = parseParams(rest.slice(1, end - 1), ctx, node.line)
  rest = rest.slice(end).trim()
  if (!rest.startsWith('=>')) {
    emit(ctx, 'E1204', node.line, `method "${out.name}" requires "=><返回类型>"`)
    return out
  }
  out.returnsText = rest.slice(2).trim()
  if (out.returnsText === '') {
    emit(ctx, 'E1204', node.line, `method "${out.name}" requires a return type after "=>"`)
    out.returnsText = 'void'
  }
  out.returns = checkType(out.returnsText, ctx, node.line, out)
  return out
}

/**
 * Parse a `## constructor:(<参数>)=>void` tail.
 * @param {string} spec - text after the `constructor` keyword.
 * @param {object} member - the member being filled in.
 * @param {object} node - the member heading.
 * @param {object} ctx - parse context.
 */
function parseConstructorTail(spec, member, node, ctx) {
  let rest = spec.trim().replace(/^:/, '').trim()
  if (!rest.startsWith('(')) {
    emit(ctx, 'E1206', node.line, 'constructor must be written "constructor:(<参数>)=>void"')
    return
  }
  const end = matchPair(rest, 0)
  if (end < 0) {
    emit(ctx, 'E1208', node.line, 'constructor has an unbalanced parameter list')
    return
  }
  member.params = parseParams(rest.slice(1, end - 1), ctx, node.line)
  const tail = rest.slice(end).trim()
  const returnsMatch = /^=>\s*(\S+)\s*$/.exec(tail)
  if (returnsMatch === null) {
    if (tail !== '') emit(ctx, 'E1206', node.line, `constructor returns void, got "${tail}"`)
    member.returnsText = 'void'
    return
  }
  member.returnsText = returnsMatch[1]
  member.returns = checkType(member.returnsText, ctx, node.line, member)
  if (returnsMatch[1] !== 'void') {
    emit(ctx, 'E1206', node.line, `constructor returns void, got "${returnsMatch[1]}"`)
  }
}

/**
 * Parse a parameter list body.
 * @param {string} body - text between the parentheses.
 * @param {object} ctx - parse context.
 * @param {number} line - heading line.
 * @returns {object[]} parameters.
 */
function parseParams(body, ctx, line) {
  const params = []
  if (body.trim() === '') return params
  let sawOptional = false
  for (const part of splitTopLevel(body)) {
    const colon = indexTopLevel(part, ':')
    if (colon < 0) {
      emit(ctx, 'E1208', line, `parameter "${part}" is missing a type`)
      continue
    }
    let head = part.slice(0, colon).trim()
    const optional = head.endsWith('?')
    if (optional) head = head.slice(0, -1).trim()
    let typeText = part.slice(colon + 1)
    let defaultValue
    const eq = indexAssign(typeText)
    if (eq >= 0) {
      defaultValue = typeText.slice(eq + 1).trim()
      typeText = typeText.slice(0, eq)
    }
    if (!isIdentifier(head)) {
      emit(ctx, 'E1208', line, head === ''
        ? `parameter "${part}" is missing a name`
        : `parameter name "${head}" is not an identifier`)
      continue
    }
    if (optional && defaultValue !== undefined) {
      emit(ctx, 'E1208', line, `parameter "${head}" declares both "?" and a default value`)
    }
    if (!optional && defaultValue === undefined && sawOptional) {
      emit(ctx, 'E1208', line, `required parameter "${head}" must precede optional parameters`)
    }
    if (optional || defaultValue !== undefined) sawOptional = true
    const param = {
      name: head,
      typeText: typeText.trim(),
      optional,
      type: checkType(typeText.trim(), ctx, line, null),
    }
    if (defaultValue !== undefined) param.defaultValue = defaultValue
    params.push(param)
  }
  return params
}

/**
 * Parse and validate a type annotation, reporting `E1204` on failure.
 * @param {string} text - annotation text.
 * @param {object} ctx - parse context.
 * @param {number} line - source line.
 * @param {object | null} target - the declaration or member receiving the type.
 * @returns {object | null} the parsed type, or `null` when invalid.
 */
function checkType(text, ctx, line, target) {
  if (text === undefined || text === null || text.trim() === '') {
    emit(ctx, 'E1204', line, 'type annotation is missing')
    return null
  }
  const node = parseType(text)
  if (node === null) {
    emit(ctx, 'E1204', line, `type annotation "${text}" is not well formed`)
    return null
  }
  if (target !== null && target !== undefined) target.typeText = text
  return node
}

/**
 * Whether one visibility modifier was written more than once (`E1211`).
 * @param {readonly string[]} modifiers - member modifiers.
 * @param {object} node - the member heading.
 * @param {object} ctx - parse context.
 */
function checkVisibility(modifiers, node, ctx) {
  const visibility = modifiers.filter(modifier => VISIBILITY_KEYWORDS.has(modifier))
  if (visibility.length > 1) {
    emit(ctx, 'E1211', node.line, `at most one visibility modifier is allowed, got ${visibility.join(', ')}`)
  }
}

/**
 * Reject modifiers a constructor does not accept (`E1202`).
 * @param {readonly string[]} modifiers - member modifiers.
 * @param {object} node - the member heading.
 * @param {object} ctx - parse context.
 */
function checkConstructorModifiers(modifiers, node, ctx) {
  for (const forbidden of ['static', 'readonly']) {
    if (modifiers.includes(forbidden)) {
      emit(ctx, 'E1202', node.line, `modifier '${forbidden}' is not valid on constructor`)
    }
  }
}

/**
 * Reject modifiers a property does not accept (`E1202`).
 * @param {readonly string[]} modifiers - member modifiers.
 * @param {object} node - the member heading.
 * @param {object} ctx - parse context.
 */
function checkPropertyModifiers(modifiers, node, ctx) {
  if (modifiers.includes('readonly')) {
    emit(ctx, 'E1202', node.line, "modifier 'readonly' is not valid on property")
  }
}

/**
 * Index of a top-level assignment `=` that is not part of `=>`, `==`, `<=`, `>=`, `!=`.
 *
 * A `=>` arrow is consumed as one token so its `>` cannot decrement the depth;
 * otherwise the first arrow in a function type pushes the depth negative and a
 * later real `=` (`## field f:(item:T)=>bool = true`) is never found.
 * @param {string} text - input text.
 * @returns {number} index, or -1 when absent.
 */
export function indexAssign(text) {
  let depth = 0
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
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
    if (char === '=' && text[index + 1] === '>') {
      index += 1
      continue
    }
    if (char === '(' || char === '<' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === '>' || char === ']' || char === '}') depth -= 1
    else if (char === '=' && depth === 0) {
      const previous = text[index - 1]
      const next = text[index + 1]
      if (next === '>' || next === '=') continue
      if (previous === '=' || previous === '!' || previous === '<' || previous === '>') continue
      return index
    }
  }
  return -1
}

/**
 * Names of the declarations and enum members a file exports, used by the
 * dependency check.
 * @param {object} doc - parsed document.
 * @returns {Set<string>} exported names.
 */
export function exportedNamesOf(doc) {
  const names = new Set()
  for (const decl of doc.decls) {
    // `# statement` is anonymous: nothing to import from it (xl-syntax §17).
    if (decl.kind === 'statement') continue
    names.add(decl.name)
    if (decl.kind === 'enum') {
      for (const item of decl.cases) names.add(item.name)
    }
  }
  return names
}

/**
 * Names of the type declarations a file declares, used by the cross-file
 * duplicate-type warning.
 * @param {object} doc - parsed document.
 * @returns {string[]} type names.
 */
export function typeNamesOf(doc) {
  return doc.decls.filter(decl => TYPE_SECTION_KINDS.has(decl.kind)).map(decl => decl.name)
}

/**
 * Whether a heading name is one of the recognized language fence names.
 * @param {string} name - heading or fence text.
 * @returns {boolean} whether the name is a known language.
 */
export function isKnownLanguage(name) {
  return LANGUAGE_NAMES.has(name)
}
