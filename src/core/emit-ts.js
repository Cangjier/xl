/**
 * The deterministic TypeScript printer — the whole of the `ts` channel
 * (xl-emit-ts). It maps IR to `.ts` source with no I/O, no clock, and no
 * randomness, so one IR always yields the same bytes.
 *
 * The acceptance standard is `docs/xl-base-case.md`: the printer's output for
 * that input must equal the documented artifact byte for byte.
 *
 * @module dsh-xl/core/emit-ts
 */

import { INDENT, bodyHasYield, normalizeCode } from './text.js'
import { generatorOf, mapType, promiseOf } from './types.js'

/** Versions stamped into the artifact fingerprint line. */
export const XL_VERSION = '0.1.0'

/** A getter body that collapses onto its declaration line (xl-emit-ts §11). */
const SINGLE_MEMBER_RETURN = /^return\s+this\.[A-Za-z_$][A-Za-z0-9_$]*;$/

/**
 * Prefix that makes a top-level declaration exported. `private` disables it:
 * `private` is not a legal modifier for a ts top-level declaration, and the
 * declaration stays file-visible instead (xl-emit-ts §5).
 * @param {object} decl - declaration with `modifiers`.
 * @returns {string} `export ` or the empty string.
 */
function exportPrefix(decl) {
  return decl.modifiers.includes('private') ? '' : 'export '
}

/**
 * Visibility keyword of a class member; omission means `public` and is printed
 * explicitly (xl-emit-ts §7).
 * @param {object} member - member or accessor with `modifiers`.
 * @returns {'public' | 'protected' | 'private'} the visibility.
 */
function visibilityOf(member) {
  return member.modifiers.find(modifier => modifier === 'public' || modifier === 'protected' || modifier === 'private')
    ?? 'public'
}

/**
 * Render a `<T extends X, V = any>` parameter list.
 * @param {readonly object[]} params - type parameters.
 * @returns {string} the parameter list, or the empty string.
 */
function renderTypeParams(params) {
  if (params.length === 0) return ''
  const parts = params.map((param) => {
    let text = param.name
    if (param.constraint !== null && param.constraint !== undefined) text += ` extends ${param.constraint}`
    if (param.default !== null && param.default !== undefined) text += ` = ${param.default}`
    return text
  })
  return `<${parts.join(', ')}>`
}

/**
 * Render a parameter list.
 * @param {readonly object[]} params - parameters.
 * @returns {string} comma-separated parameter text.
 */
function renderParams(params) {
  return params.map((param) => {
    const type = mapType(param.type)
    if (param.optional) return `${param.name}?: ${type}`
    if (param.defaultValue !== undefined) return `${param.name}: ${type} = ${param.defaultValue}`
    return `${param.name}: ${type}`
  }).join(', ')
}

/**
 * Render a return type, applying the async and generator wrappers.
 * @param {object} member - member with `returns`, `async`, and a body.
 * @param {string} body - normalized member body.
 * @returns {string} the return type.
 */
function renderReturns(member, body) {
  const mapped = mapType(member.returns)
  if (bodyHasYield(body)) return generatorOf(mapped)
  if (member.async) return promiseOf(mapped)
  return mapped
}

/**
 * Render a declaration head plus its body.
 *
 * The body rules (xl-emit-ts §11): an empty body becomes `{}`; a getter whose
 * body is exactly `return this.<member>;` collapses onto one line; every other
 * body expands to `{`, the indented body, and `}`.
 * @param {string} head - declaration text before the body.
 * @param {string} body - normalized body text.
 * @param {object} [options] - `accessor` enables the one-line collapse.
 * @returns {string[]} rendered lines.
 */
function renderBody(head, body, options = {}) {
  if (body === '') return [`${head} {}`]
  const lines = body.split('\n')
  if (options.accessor === true && lines.length === 1 && SINGLE_MEMBER_RETURN.test(lines[0].trim())) {
    return [`${head} { ${lines[0].trim()} }`]
  }
  return [head + ' {', ...lines.map(line => (line === '' ? '' : INDENT + line)), '}']
}

/**
 * Split normalized code into lines and terminate the last one with `;`.
 * @param {string} code - normalized code block.
 * @returns {string[]} lines with the terminating semicolon.
 */
function terminate(code) {
  const lines = code.split('\n')
  lines[lines.length - 1] = `${lines[lines.length - 1]};`
  return lines
}

/**
 * Render a `# const` declaration.
 * @param {object} decl - the declaration.
 * @returns {string[]} rendered lines.
 */
function renderConst(decl) {
  const head = `${exportPrefix(decl)}const ${decl.name}: ${mapType(decl.type)}`
  if (decl.defaultValue !== undefined) return [`${head} = ${decl.defaultValue};`]
  const code = decl.body === null ? '' : normalizeCode(decl.body.rawBody)
  if (code === '') return [`${head};`]
  const lines = terminate(code)
  return [`${head} = ${lines[0]}`, ...lines.slice(1)]
}

/**
 * Render a module-level `# method`.
 * @param {object} decl - the declaration.
 * @returns {string[]} rendered lines.
 */
function renderModuleMethod(decl) {
  const body = decl.body === null ? '' : normalizeCode(decl.body.rawBody)
  const generator = bodyHasYield(body)
  const star = generator ? '*' : ''
  const asyncPrefix = decl.async ? 'async ' : ''
  const head = `${exportPrefix(decl)}${asyncPrefix}function${star} ${decl.name}`
    + `${renderTypeParams(decl.typeParams)}(${renderParams(decl.params)}): ${renderReturns(decl, body)}`
  return renderBody(head, body)
}

/**
 * Render an `# enum` declaration. Members are separated by commas with no
 * blank lines and no trailing comma (xl-emit-ts §6.1).
 * @param {object} decl - the declaration.
 * @returns {string[]} rendered lines.
 */
function renderEnum(decl) {
  const lines = [`${exportPrefix(decl)}enum ${decl.name} {`]
  decl.cases.forEach((item, index) => {
    const value = item.value === null ? '' : ` = ${item.value}`
    lines.push(`${INDENT}${item.name}${value}${index < decl.cases.length - 1 ? ',' : ''}`)
  })
  lines.push('}')
  return lines
}

/**
 * Render one interface member (xl-emit-ts §6.2).
 * @param {object} member - the member.
 * @returns {string} the member line.
 */
function renderInterfaceMember(member) {
  if (member.kind === 'field') {
    const readonly = member.modifiers.includes('readonly') ? 'readonly ' : ''
    return `${readonly}${member.name}${member.optional ? '?' : ''}: ${mapType(member.type)};`
  }
  const returns = member.async ? promiseOf(mapType(member.returns)) : mapType(member.returns)
  return `${member.name}${renderTypeParams(member.typeParams)}(${renderParams(member.params)}): ${returns};`
}

/**
 * Render an `# interface` declaration.
 * @param {object} decl - the declaration.
 * @returns {string[]} rendered lines.
 */
function renderInterface(decl) {
  const extension = decl.extends === null ? '' : ` extends ${decl.extends}`
  const lines = [`${exportPrefix(decl)}interface ${decl.name}${extension} {`]
  for (const member of decl.members) lines.push(`${INDENT}${renderInterfaceMember(member)}`)
  lines.push('}')
  return lines
}

/**
 * Render a class field (xl-emit-ts §7).
 * @param {object} member - the field.
 * @returns {string[]} rendered lines.
 */
function renderField(member) {
  const parts = [visibilityOf(member)]
  if (member.modifiers.includes('static')) parts.push('static')
  if (member.modifiers.includes('readonly')) parts.push('readonly')
  const head = `${parts.join(' ')} ${member.name}${member.optional ? '?' : ''}: ${mapType(member.type)}`
  if (member.defaultValue !== undefined) return [`${head} = ${member.defaultValue};`]
  const code = member.body === null ? '' : normalizeCode(member.body.rawBody)
  if (code === '') return [`${head};`]
  const lines = terminate(code)
  return [`${head} = ${lines[0]}`, ...lines.slice(1)]
}

/**
 * Render a class method (xl-emit-ts §9.1).
 * @param {object} member - the method.
 * @returns {string[]} rendered lines.
 */
function renderMethod(member) {
  const body = member.body === null ? '' : normalizeCode(member.body.rawBody)
  const generator = bodyHasYield(body)
  const staticPart = member.modifiers.includes('static') ? 'static ' : ''
  const asyncPart = member.async ? 'async ' : ''
  const star = generator ? '*' : ''
  const head = `${visibilityOf(member)} ${staticPart}${asyncPart}${star}${member.name}`
    + `${renderTypeParams(member.typeParams)}(${renderParams(member.params)}): ${renderReturns(member, body)}`
  return renderBody(head, body)
}

/**
 * Render a class constructor (xl-emit-ts §9.2). The visibility keyword is
 * printed only when the source wrote one, so an unmodified constructor keeps
 * the bare `constructor(...)` form.
 * @param {object} member - the constructor.
 * @returns {string[]} rendered lines.
 */
function renderConstructor(member) {
  const body = member.body === null ? '' : normalizeCode(member.body.rawBody)
  const head = member.modifiers.length > 0
    ? `${visibilityOf(member)} constructor(${renderParams(member.params)})`
    : `constructor(${renderParams(member.params)})`
  return renderBody(head, body)
}

/**
 * Expand a `property` into its backing field and accessors (xl-emit-ts §8).
 * @param {object} member - the property.
 * @returns {object[]} rendered parts.
 */
function renderProperty(member) {
  const name = member.name === '' ? 'value' : member.name
  const type = mapType(member.type)
  const backing = `#${name}`
  const getter = member.accessors.find(accessor => accessor.kind === 'get') ?? null
  const setter = member.accessors.find(accessor => accessor.kind === 'set') ?? null
  const getterBody = getter === null || getter.body === null ? '' : normalizeCode(getter.body.rawBody)
  const setterBody = setter === null || setter.body === null ? '' : normalizeCode(setter.body.rawBody)
  const generatorGetter = getterBody !== '' && bodyHasYield(getterBody)
  const getterHasBody = getterBody !== '' && !generatorGetter
  // A backing field carries the initial value, and it appears whenever the
  // getter cannot compute the value on its own.
  const needsBacking = member.defaultValue !== undefined || !getterHasBody

  const parts = []
  if (needsBacking) {
    const init = member.defaultValue === undefined ? '' : ` = ${member.defaultValue}`
    parts.push({ lines: [`${backing}: ${type}${init};`], role: 'field', owner: name })
  }
  if (getter !== null) {
    if (getterBody === '') {
      parts.push({ lines: [`${visibilityOf(getter)} get ${name}(): ${type} { return this.${backing}; }`], role: 'accessor', owner: name })
    } else if (generatorGetter) {
      const head = `${visibilityOf(getter)} *${name}(): Generator<${type}>`
      parts.push({ lines: renderBody(head, getterBody), role: 'accessor', owner: name })
    } else {
      const head = `${visibilityOf(getter)} get ${name}(): ${type}`
      parts.push({ lines: renderBody(head, getterBody, { accessor: true }), role: 'accessor', owner: name })
    }
  }
  if (setter !== null) {
    const visibility = visibilityOf(setter)
    const lines = setterBody === ''
      ? [`${visibility} set ${name}(value: ${type}) { this.${backing} = value; }`]
      : renderBody(`${visibility} set ${name}(value: ${type})`, setterBody)
    parts.push({ lines, role: 'accessor', owner: name })
  }
  return parts
}

/**
 * Expand one class member into rendered parts.
 * @param {object} member - the member.
 * @returns {object[]} rendered parts.
 */
function memberParts(member) {
  switch (member.kind) {
    case 'field':
      return [{ lines: renderField(member), role: 'field', owner: null }]
    case 'property':
      return renderProperty(member)
    case 'method':
      return [{ lines: renderMethod(member), role: 'member', owner: null }]
    case 'constructor':
      return [{ lines: renderConstructor(member), role: 'member', owner: null }]
    default:
      return []
  }
}

/**
 * Join rendered class parts, deciding the blank lines between them.
 *
 * Two single-line fields stay adjacent, and the accessors of one property stay
 * adjacent; every other boundary takes one blank line (xl-emit-ts §10, read
 * from the base case).
 * @param {readonly object[]} parts - rendered parts.
 * @returns {string[]} indented class body lines.
 */
function joinClassParts(parts) {
  const out = []
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (index > 0) {
      const previous = parts[index - 1]
      const tight = (previous.role === 'field' && part.role === 'field'
          && previous.lines.length === 1 && part.lines.length === 1)
        || (previous.owner !== null && previous.owner === part.owner
          && previous.role === 'accessor' && part.role === 'accessor')
      if (!tight) out.push('')
    }
    out.push(...part.lines)
  }
  return out.map(line => (line === '' ? '' : INDENT + line))
}

/**
 * Render a `# class` declaration.
 * @param {object} decl - the declaration.
 * @returns {string[]} rendered lines.
 */
function renderClass(decl) {
  const generics = renderTypeParams(decl.typeParams)
  const extension = decl.extends === null ? '' : ` extends ${decl.extends}`
  const implementation = decl.implements.length === 0 ? '' : ` implements ${decl.implements.join(', ')}`
  const lines = [`${exportPrefix(decl)}class ${decl.name}${generics}${extension}${implementation} {`]
  const parts = decl.members.flatMap(memberParts)
  lines.push(...joinClassParts(parts))
  lines.push('}')
  return lines
}

/**
 * Render one first-level declaration.
 * @param {object} decl - the declaration.
 * @returns {string[]} rendered lines.
 */
export function renderDecl(decl) {
  switch (decl.kind) {
    case 'type':
      return [`${exportPrefix(decl)}type ${decl.name} = ${decl.typeTextRaw ?? 'unknown'};`]
    case 'const':
      return renderConst(decl)
    case 'method':
      return renderModuleMethod(decl)
    case 'enum':
      return renderEnum(decl)
    case 'interface':
      return renderInterface(decl)
    case 'class':
      return renderClass(decl)
    default:
      return []
  }
}

/**
 * Rewrite one `# dependencies` xl import into a ts import statement.
 * @param {string} from - the `.xl.md` target path.
 * @returns {string} the module specifier with the `.xl.md` suffix removed.
 */
export function rewriteImportPath(from) {
  return from.replace(/\.xl\.md$/, '')
}

/**
 * The dependency import segment: the default-language blocks verbatim, then an
 * import for every xl dependency not already handwritten (xl-emit-ts §3).
 * @param {object} doc - parsed document.
 * @returns {string} the segment text, or the empty string.
 */
function dependencySegment(doc) {
  const blocks = doc.dependencies === null ? [] : doc.dependencies.blocks
  const manual = blocks.map(block => normalizeCode(block.rawBody)).filter(text => text !== '').join('\n\n')
  const manualSpecifiers = new Set(
    [...manual.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]),
  )
  /** @type {Map<string, string[]>} */
  const generated = new Map()
  for (const record of doc.dependencies?.imports ?? []) {
    const specifier = rewriteImportPath(record.from)
    if (manualSpecifiers.has(specifier)) continue
    const names = generated.get(specifier) ?? []
    for (const entry of record.names) {
      names.push(entry.alias === null ? entry.name : `${entry.name} as ${entry.alias}`)
    }
    generated.set(specifier, names)
  }
  const generatedLines = [...generated].map(
    ([specifier, names]) => `import { ${names.join(', ')} } from "${specifier}";`,
  )
  if (manual === '' && generatedLines.length === 0) return ''
  return [manual, ...generatedLines].filter(text => text !== '').join('\n')
}

/**
 * Render the artifact body: dependency imports, then every declaration in
 * source order, separated by exactly one blank line (xl-emit-ts §2, §10).
 * @param {object} doc - parsed document.
 * @returns {string} the body, without a trailing newline.
 */
export function printTypeScriptBody(doc) {
  const segments = []
  const dependencies = dependencySegment(doc)
  if (dependencies !== '') segments.push(dependencies)
  for (const decl of doc.decls) {
    const lines = renderDecl(decl)
    if (lines.length > 0) segments.push(lines.join('\n'))
  }
  return segments.join('\n\n')
}

/**
 * Render a complete ts artifact.
 * @param {object} doc - parsed document.
 * @param {object} options - artifact facts.
 * @param {string} options.sourcePath - source path recorded in the header.
 * @param {string} options.fingerprint - source fingerprint recorded in the header.
 * @param {(header: object) => string} options.renderHeader - header renderer.
 * @param {boolean} [options.header] - whether to write the artifact header.
 * @returns {string} the artifact text, ending in exactly one newline.
 */
export function printTypeScriptFile(doc, options) {
  const body = printTypeScriptBody(doc)
  if (options.header === false) return `${body}\n`
  const head = options.renderHeader({
    sourcePath: options.sourcePath,
    fingerprint: options.fingerprint,
    target: 'ts',
  })
  return `${head}\n\n${body}\n`
}
