/**
 * Target descriptors: which languages exist, which channel generates them,
 * which **parts** one artifact consists of, what extension and layout they use,
 * and how a type name becomes a file name (xl-cli §3.3, §3.5).
 *
 * A target's `parts` are the files one planned unit produces. Almost every
 * language has exactly one, so `parts` is invisible for them; C++ needs two —
 * `header` (`.h`) and `source` (`.cpp`) — and that is a property of the target,
 * exactly like `layout`, never a property of the invocation.
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

/** Role of the only part of a single-file target. */
export const PART_ROLE_FILE = 'file'

/** Role of a C++ declaration part. */
export const PART_ROLE_HEADER = 'header'

/** Role of a C++ definition part. */
export const PART_ROLE_SOURCE = 'source'

/**
 * A part's `requires` value meaning "plan this part only when the unit carries
 * executable content" — a definition, not a declaration.
 */
export const PART_REQUIRES_BODIES = 'bodies'

/** A part that declares symbols: it must mention every member of its unit. */
export const PART_SCOPE_DECLARATION = 'declaration'

/** A part that defines some of a unit's members; only the ones it names are checked. */
export const PART_SCOPE_DEFINITION = 'definition'

/** Part scopes the structural read-back check understands. */
export const PART_SCOPES = new Set([PART_SCOPE_DECLARATION, PART_SCOPE_DEFINITION])

/**
 * Built-in targets, keyed by canonical language name.
 *
 * The layout is a property of the target, not of an invocation: `ts` is
 * printed by the direct channel as exactly one file per source, and every
 * harness target is always `type` — one file per declaration. There is no
 * override and no per-target exemption, so two runs of the same source can
 * never disagree about which files should exist.
 *
 * `parts` is the same kind of property: one entry per file a planned unit
 * produces, in the order they are planned. `cpp` is the only built-in target
 * with more than one, and its `source` part exists only when the unit actually
 * declares a body — a header-only class stays a single `.h` file, because a
 * planned output the generator has nothing to put in would be a false demand.
 */
export const BUILTIN_TARGETS = {
  ts: { layout: 'file', channel: 'direct', parts: [{ role: PART_ROLE_FILE, ext: '.ts' }] },
  csharp: { layout: 'type', channel: 'harness', parts: [{ role: PART_ROLE_FILE, ext: '.cs' }] },
  java: { layout: 'type', channel: 'harness', parts: [{ role: PART_ROLE_FILE, ext: '.java' }] },
  python: { layout: 'type', channel: 'harness', parts: [{ role: PART_ROLE_FILE, ext: '.py' }] },
  go: { layout: 'type', channel: 'harness', parts: [{ role: PART_ROLE_FILE, ext: '.go' }] },
  rust: { layout: 'type', channel: 'harness', parts: [{ role: PART_ROLE_FILE, ext: '.rs' }] },
  cpp: {
    layout: 'type',
    channel: 'harness',
    parts: [
      { role: PART_ROLE_HEADER, ext: '.h', scope: PART_SCOPE_DECLARATION },
      {
        role: PART_ROLE_SOURCE,
        ext: '.cpp',
        requires: PART_REQUIRES_BODIES,
        scope: PART_SCOPE_DEFINITION,
      },
    ],
  },
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
  'c++': 'cpp',
  cplusplus: 'cpp',
  cxx: 'cpp',
}

/** Targets whose idiomatic type file name is PascalCase. */
const PASCAL_TARGETS = new Set(['csharp', 'java', 'kotlin', 'kt', 'go', 'golang', 'swift', 'scala', 'dart'])

/** Targets whose idiomatic type file name is snake_case. */
const SNAKE_TARGETS = new Set(['python', 'py', 'rust', 'rs', 'cpp'])

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
 * Normalize a declared part list, rejecting anything a planner could not read.
 * @param {unknown} value - `targets.<lang>.parts` from `xl.json`.
 * @param {string} name - canonical target name, for the message.
 * @returns {object[]} normalized parts with `role`, `ext`, and optional `requires` / `scope`.
 * @throws {UsageError} when the declaration is not a usable part list.
 */
export function normalizeParts(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UsageError(`custom target "${name}" declares "parts" that is not a non-empty array`, 'E0004')
  }
  const parts = []
  const roles = new Set()
  for (const [index, raw] of value.entries()) {
    if (raw === null || typeof raw !== 'object') {
      throw new UsageError(`part ${index + 1} of custom target "${name}" is not an object`, 'E0004')
    }
    const role = typeof raw.role === 'string' && raw.role.trim() !== '' ? raw.role.trim() : `part${index + 1}`
    if (roles.has(role)) {
      throw new UsageError(`custom target "${name}" declares part role "${role}" twice`, 'E0004')
    }
    roles.add(role)
    if (typeof raw.ext !== 'string' || raw.ext.trim() === '') {
      throw new UsageError(`part "${role}" of custom target "${name}" must declare "ext"`, 'E0004')
    }
    if (raw.requires !== undefined && raw.requires !== PART_REQUIRES_BODIES) {
      throw new UsageError(`part "${role}" of custom target "${name}" has unknown requires "${raw.requires}"; known: "${PART_REQUIRES_BODIES}"`, 'E0004')
    }
    if (raw.scope !== undefined && !PART_SCOPES.has(raw.scope)) {
      throw new UsageError(`part "${role}" of custom target "${name}" has unknown scope "${raw.scope}"; known: ${[...PART_SCOPES].join(', ')}`, 'E0004')
    }
    parts.push({
      role,
      ext: raw.ext.startsWith('.') ? raw.ext : `.${raw.ext}`,
      ...raw.requires === undefined ? {} : { requires: raw.requires },
      ...raw.scope === undefined ? {} : { scope: raw.scope },
    })
  }
  return parts
}

/**
 * Resolve one target request into a descriptor.
 *
 * A built-in target carries its own part list. A declared target carries either
 * `parts` or the single `ext` every earlier `xl.json` used; both resolve to the
 * same shape, so nothing downstream has to know which spelling was written.
 * @param {string} lang - requested language.
 * @param {object} config - loaded `xl.json` document.
 * @returns {object} the target descriptor.
 * @throws {UsageError} when the language is neither built-in nor declared.
 */
export function resolveTarget(lang, config) {
  const name = canonicalLang(lang)
  const builtin = BUILTIN_TARGETS[name]
  if (builtin !== undefined) {
    const parts = builtin.parts.map(part => ({ ...part }))
    return {
      name,
      requested: lang,
      parts,
      ext: parts[0].ext,
      layout: builtin.layout,
      channel: builtin.channel,
      comment: commentMarkerFor(name, parts[0].ext),
      namespace: config?.targets?.[name]?.namespace ?? null,
      model: config?.targets?.[name]?.model ?? null,
    }
  }
  const declared = config?.targets?.[name]
  if (declared === undefined) {
    throw new UsageError(`unknown target "${lang}"`, 'E0003')
  }
  let parts
  if (declared.parts !== undefined) {
    parts = normalizeParts(declared.parts, name)
  } else if (typeof declared.ext === 'string' && declared.ext.trim() !== '') {
    parts = [{ role: PART_ROLE_FILE, ext: declared.ext.startsWith('.') ? declared.ext : `.${declared.ext}` }]
  } else {
    throw new UsageError(`custom target "${name}" must declare "targets.${name}.ext" or "targets.${name}.parts" in xl.json`, 'E0004')
  }
  return {
    name,
    requested: lang,
    parts,
    ext: parts[0].ext,
    // A custom target uses the harness channel, and the harness channel is
    // always `type`; a declared `targets.<lang>.layout` is read past on purpose.
    layout: LAYOUT_TYPE,
    channel: 'harness',
    comment: commentMarkerFor(name, parts[0].ext),
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
 * Go and snake_case for Python / Rust / C++, plus the `I` prefix C# and Java
 * writers put on an interface name (the specification's own example maps the
 * interface `printable` to `IPrintable.cs`).
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
