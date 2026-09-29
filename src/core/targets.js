/**
 * Target descriptors: which languages exist, which channel generates them,
 * what extension and layout they use, and how a type name becomes a file name
 * (xl-cli §3.3, §3.5).
 *
 * @module xl/core/targets
 */

import { commentMarkerFor } from './parse.js'

/**
 * A configuration or invocation problem that exits 2 and never enters
 * diagnostic counting (xl-cli §3.8).
 */
export class UsageError extends Error {
  /**
   * @param {string} message - the usage problem.
   * @param {string} code - the usage diagnostic code.
   */
  constructor(message, code) {
    super(message)
    this.name = 'UsageError'
    this.code = code
  }
}

/**
 * Built-in targets, keyed by canonical language name.
 *
 * The layout is a property of the target, not of an invocation: `ts` is
 * printed by the direct channel as exactly one file per source, and every
 * harness target is always `type` — one file per declaration. There is no
 * override and no per-target exemption, so two runs of the same source can
 * never disagree about which files should exist.
 */
export const BUILTIN_TARGETS = {
  ts: { ext: '.ts', layout: 'file', channel: 'direct' },
  csharp: { ext: '.cs', layout: 'type', channel: 'harness' },
  java: { ext: '.java', layout: 'type', channel: 'harness' },
  python: { ext: '.py', layout: 'type', channel: 'harness' },
  go: { ext: '.go', layout: 'type', channel: 'harness' },
  rust: { ext: '.rs', layout: 'type', channel: 'harness' },
}

/** Spellings accepted for a built-in target. */
export const TARGET_ALIASES = {
  typescript: 'ts',
  cs: 'csharp',
  'c#': 'csharp',
  py: 'python',
  python3: 'python',
  golang: 'go',
  rs: 'rust',
  '.net': 'csharp',
}

/** Targets whose idiomatic type file name is PascalCase. */
const PASCAL_TARGETS = new Set(['csharp', 'java', 'kotlin', 'kt', 'go', 'golang', 'swift', 'scala', 'dart'])

/** Targets whose idiomatic type file name is snake_case. */
const SNAKE_TARGETS = new Set(['python', 'py', 'rust', 'rs'])

/** Targets whose idiomatic interface file name carries the `I` prefix. */
const INTERFACE_PREFIX_TARGETS = new Set(['csharp', 'java'])

/** Language that every source's default code block is written in. */
export const SOURCE_LANG = 'ts'

/** Layout mode for a target that emits one file per source. */
export const LAYOUT_FILE = 'file'

/** Layout mode for a target that emits one file per type declaration. */
export const LAYOUT_TYPE = 'type'

/** Suffix appended to the source base name for module-level declarations. */
export const MODULE_FILE_SUFFIX = 'Module'

/**
 * Resolve a language spelling to its canonical built-in name.
 * @param {string} lang - requested language.
 * @returns {string} canonical name, or the input when it is not a built-in.
 */
export function canonicalLang(lang) {
  const lowered = lang.trim().toLowerCase()
  return TARGET_ALIASES[lowered] ?? lowered
}

/**
 * Resolve one target request into a descriptor.
 * @param {string} lang - requested language.
 * @param {object} config - loaded `xl.json` document.
 * @returns {object} the target descriptor.
 * @throws {UsageError} when the language is neither built-in nor declared.
 */
export function resolveTarget(lang, config) {
  const name = canonicalLang(lang)
  const builtin = BUILTIN_TARGETS[name]
  if (builtin !== undefined) {
    return {
      name,
      requested: lang,
      ext: builtin.ext,
      layout: builtin.layout,
      channel: builtin.channel,
      comment: commentMarkerFor(name, builtin.ext),
      namespace: config?.targets?.[name]?.namespace ?? null,
      model: config?.targets?.[name]?.model ?? null,
    }
  }
  const declared = config?.targets?.[name]
  if (declared === undefined) {
    throw new UsageError(`unknown target "${lang}"`, 'E0003')
  }
  if (typeof declared.ext !== 'string' || declared.ext.trim() === '') {
    throw new UsageError(`custom target "${name}" must declare "targets.${name}.ext" in xl.json`, 'E0004')
  }
  const ext = declared.ext.startsWith('.') ? declared.ext : `.${declared.ext}`
  return {
    name,
    requested: lang,
    ext,
    // A custom target uses the harness channel, and the harness channel is
    // always `type`; a declared `targets.<lang>.layout` is read past on purpose.
    layout: LAYOUT_TYPE,
    channel: 'harness',
    comment: commentMarkerFor(name, ext),
    namespace: declared.namespace ?? null,
    model: declared.model ?? null,
  }
}

/**
 * Resolve every requested target, preserving order and dropping duplicates.
 * @param {readonly string[]} langs - requested languages.
 * @param {object} config - loaded `xl.json` document.
 * @returns {object[]} target descriptors.
 * @throws {UsageError} when a language is unknown or under-declared.
 */
export function resolveTargets(langs, config) {
  const out = []
  const seen = new Set()
  for (const lang of langs) {
    const descriptor = resolveTarget(lang, config)
    if (seen.has(descriptor.name)) continue
    seen.add(descriptor.name)
    out.push(descriptor)
  }
  return out
}

/**
 * Convert an identifier to `snake_case`.
 * @param {string} name - identifier.
 * @returns {string} snake_case text.
 */
function toSnakeCase(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

/**
 * Convert an identifier to `PascalCase`.
 * @param {string} name - identifier.
 * @returns {string} PascalCase text.
 */
function toPascalCase(name) {
  return name
    .split(/[_\s]+/)
    .filter(part => part !== '')
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('')
}

/**
 * File base name for a type declaration under `layout=type`.
 *
 * `idiomatic` follows the target's own convention: PascalCase for C# / Java /
 * Go and snake_case for Python / Rust, plus the `I` prefix C# and Java writers
 * put on an interface name (the specification's own example maps the interface
 * `printable` to `IPrintable.cs`).
 * @param {string} typeName - the declared type name.
 * @param {string} lang - canonical target language.
 * @param {'idiomatic' | 'preserve'} naming - naming policy.
 * @param {'class' | 'interface' | 'enum'} [kind] - the declaration's kind.
 * @returns {string} the file base name, without an extension.
 */
export function typeFileBaseName(typeName, lang, naming, kind) {
  if (naming === 'preserve') return typeName
  if (kind === 'interface' && INTERFACE_PREFIX_TARGETS.has(lang)) {
    return `I${toPascalCase(typeName.replace(/^I(?=[A-Z])/, ''))}`
  }
  if (PASCAL_TARGETS.has(lang)) return toPascalCase(typeName)
  if (SNAKE_TARGETS.has(lang)) return toSnakeCase(typeName)
  return typeName
}

/**
 * Names of every known target, built-in first then declared ones.
 * @param {object} config - loaded `xl.json` document.
 * @returns {object[]} descriptors for `xl targets`.
 */
export function listTargets(config) {
  const out = Object.keys(BUILTIN_TARGETS).map(name => resolveTarget(name, config))
  for (const name of Object.keys(config?.targets ?? {})) {
    if (canonicalLang(name) in BUILTIN_TARGETS) continue
    out.push(resolveTarget(name, config))
  }
  return out
}
