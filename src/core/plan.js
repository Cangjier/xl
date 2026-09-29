/**
 * Output planning: which files one source produces for one target, and which
 * planned paths collide (xl-cli §3.5).
 *
 * The layout rule, stated once: the effective output root is `--out`, then
 * `build.out`, then `dist`. Every target then gets its own language directory
 * under that root — `dist/ts`, `dist/csharp`, … — so two languages never share
 * a tree and each one's cache sits beside the products it describes. A
 * `file`-layout target (only `ts`) keeps the source's relative directory under
 * its language directory and emits one file per source; a `type`-layout target
 * (every harness target) emits one file per type plus one module file for the
 * module-level declarations. The layout comes from the target descriptor alone:
 * no invocation can change it.
 *
 * Within one planned unit, the target's `parts` decide how many files it
 * produces: one for every language whose artifact is a single file, and two for
 * C++ (`.h` + `.cpp`). A part marked `requires: 'bodies'` is planned only when
 * the unit carries executable content, so a header-only class plans one file
 * rather than an empty second one. Every output therefore names its `part`, its
 * `ext`, and its verification `scope`; `xl_emit` accepts exactly the planned
 * paths.
 *
 * @module xl/core/plan
 */

import {
  LAYOUT_TYPE,
  MODULE_FILE_SUFFIX,
  PART_REQUIRES_BODIES,
  PART_SCOPE_DECLARATION,
  typeFileBaseName,
} from './targets.js'
import { toPosix } from './text.js'

/**
 * Normalize an output root to a POSIX prefix without a trailing slash.
 * @param {string | null | undefined} out - configured output directory.
 * @returns {string} the prefix, or the empty string for the working directory.
 */
export function outputRoot(out) {
  if (out === null || out === undefined) return ''
  const normalized = toPosix(String(out)).replace(/\/+$/, '').replace(/^\.\//, '')
  return normalized === '.' ? '' : normalized
}

/**
 * Join path segments, dropping empty ones.
 * @param {readonly (string | null | undefined)[]} segments - path segments.
 * @returns {string} the joined POSIX path.
 */
function joinPath(segments) {
  return segments.filter(segment => segment !== null && segment !== undefined && segment !== '').join('/')
}

/**
 * The directory of a source path relative to the search root.
 * @param {string} sourceRel - POSIX source path.
 * @param {boolean} flat - whether `--flat` discards the directory.
 * @returns {string} the directory, or the empty string.
 */
function sourceDirectory(sourceRel, flat) {
  if (flat) return ''
  const index = sourceRel.lastIndexOf('/')
  return index < 0 ? '' : sourceRel.slice(0, index)
}

/**
 * The source file's base name, without the `.xl.md` suffix.
 * @param {string} sourceRel - POSIX source path.
 * @returns {string} the base name.
 */
export function sourceBaseName(sourceRel) {
  const slash = sourceRel.lastIndexOf('/')
  const name = slash < 0 ? sourceRel : sourceRel.slice(slash + 1)
  return name.replace(/\.xl\.md$/, '')
}

/**
 * Declarations that carry no target-language type name and therefore share the
 * module file under `layout=type` (xl-cli §3.4). A `# statement` carries no
 * name at all, but its code still needs a file to live in — the module file.
 */
const MODULE_KINDS = new Set(['type', 'const', 'method', 'statement'])

/**
 * Names recorded for a planned output: one per declaration, in source order.
 *
 * A `# statement` section declares no name, so it is labelled by its 1-based
 * position among the file's statements (`# statement 1`): the plan must still
 * tell a generator that this source carries top-level statements (xl-syntax §17).
 * @param {readonly object[]} decls - the declarations of one source.
 * @returns {string[]} the labels.
 */
function declaredNames(decls) {
  const names = []
  let statements = 0
  for (const decl of decls) {
    if (decl.kind !== 'statement') {
      names.push(decl.name)
      continue
    }
    statements += 1
    names.push(`# statement ${statements}`)
  }
  return names
}

/**
 * Whether one IR node carries executable content: a default-language body, or a
 * body fenced for this target language.
 *
 * Both count. A member may legitimately have no `ts` body and only a
 * `### cpp` section (`W3010` is a warning about having neither), and that
 * section's code is exactly what the definition part exists to hold.
 * @param {object} node - a declaration, member, or accessor.
 * @param {string} lang - canonical target language.
 * @returns {boolean} whether the node carries executable content.
 */
function carriesBodies(node, lang) {
  if (node.body !== null && node.body !== undefined) return true
  for (const section of node.sections ?? []) {
    if (section.lang !== lang) continue
    if (section.blocks.some(block => block.rawBody.trim() !== '')) return true
  }
  return false
}

/**
 * Whether a planned unit needs its conditional parts: does it declare a
 * definition rather than a declaration only?
 *
 * `enum`, `interface`, and `# type` are declarations wherever a `## <lang>`
 * section puts their language-specific spelling, so they never need a second
 * part. A `# statement` is executable by definition. Everything else — a class,
 * a module-level `# method` / `# const` — needs one when it carries a body.
 * @param {object} decl - the declaration being planned.
 * @param {string} lang - canonical target language.
 * @returns {boolean} whether the unit carries executable content.
 */
export function unitNeedsBodies(decl, lang) {
  if (decl.kind === 'statement') return true
  if (decl.kind === 'enum' || decl.kind === 'interface' || decl.kind === 'type') return false
  if (carriesBodies(decl, lang)) return true
  for (const member of decl.members ?? []) {
    if (carriesBodies(member, lang)) return true
    for (const accessor of member.accessors ?? []) {
      if (carriesBodies(accessor, lang)) return true
    }
  }
  return false
}

/**
 * The parts one plan unit actually produces.
 *
 * A unit always produces at least one file: when every declared part is
 * conditional and none applies, the unconditional ones are used, and a target
 * that declares nothing but conditional parts falls back to its first. That
 * keeps the invariant that a source never silently plans zero files.
 * @param {readonly object[]} parts - the target's parts.
 * @param {boolean} needsBodies - whether the unit carries executable content.
 * @returns {object[]} the planned parts, in declaration order.
 */
export function plannedParts(parts, needsBodies) {
  const planned = parts.filter(part => part.requires !== PART_REQUIRES_BODIES || needsBodies)
  if (planned.length > 0) return planned
  const unconditional = parts.filter(part => part.requires !== PART_REQUIRES_BODIES)
  return unconditional.length > 0 ? unconditional : [parts[0]]
}

/**
 * Plan one source file for one target.
 * @param {object} doc - parsed document.
 * @param {string} sourceRel - POSIX source path relative to the working directory.
 * @param {object} target - target descriptor from `resolveTarget`.
 * @param {object} options - planning options.
 * @param {string | null} [options.out] - output root.
 * @param {boolean} [options.flat] - whether `--flat` discards the source directory.
 * @param {'idiomatic' | 'preserve'} [options.naming] - naming policy.
 * @returns {object} the plan: `outputs` with `path`, `base`, `kind`, `part`, `ext`, `scope`, and `names`.
 */
export function planSource(doc, sourceRel, target, options) {
  const layout = target.layout
  const naming = options.naming ?? 'idiomatic'
  const root = outputRoot(options.out)
  const directory = sourceDirectory(sourceRel, options.flat === true)
  const base = sourceBaseName(sourceRel)
  const targetRoot = joinPath([root, target.name])
  const parts = target.parts ?? [{ role: 'file', ext: target.ext }]
  const outputOf = (part, path, base, kind, names) => ({
    path,
    base,
    kind,
    part: part.role,
    ext: part.ext,
    scope: part.scope ?? PART_SCOPE_DECLARATION,
    names,
  })

  if (layout !== LAYOUT_TYPE) {
    const planParts = plannedParts(parts, doc.decls.some(decl => unitNeedsBodies(decl, target.name)))
    return {
      src: sourceRel,
      target: target.name,
      channel: target.channel,
      layout: 'file',
      ext: planParts[0].ext,
      outputs: planParts.map(part => outputOf(
        part,
        joinPath([targetRoot, directory, `${base}${part.ext}`]),
        base,
        'file',
        declaredNames(doc.decls),
      )),
    }
  }

  const outputs = []
  const moduleDecls = doc.decls.filter(decl => MODULE_KINDS.has(decl.kind))
  const moduleNames = declaredNames(moduleDecls)
  if (moduleDecls.length > 0) {
    const moduleBase = typeFileBaseName(`${base}${MODULE_FILE_SUFFIX}`, target.name, naming)
    const needsBodies = moduleDecls.some(decl => unitNeedsBodies(decl, target.name))
    for (const part of plannedParts(parts, needsBodies)) {
      outputs.push(outputOf(
        part,
        joinPath([targetRoot, directory, `${moduleBase}${part.ext}`]),
        moduleBase,
        'module',
        moduleNames,
      ))
    }
  }
  for (const decl of doc.decls) {
    if (MODULE_KINDS.has(decl.kind)) continue
    const typeBase = typeFileBaseName(decl.name, target.name, naming, decl.kind)
    const needsBodies = unitNeedsBodies(decl, target.name)
    for (const part of plannedParts(parts, needsBodies)) {
      outputs.push(outputOf(
        part,
        joinPath([targetRoot, directory, `${typeBase}${part.ext}`]),
        typeBase,
        'type',
        [decl.name],
      ))
    }
  }
  return {
    src: sourceRel,
    target: target.name,
    channel: target.channel,
    layout: 'type',
    ext: parts[0].ext,
    outputs,
  }
}

/**
 * Find every planned path claimed more than once (`E2001`).
 *
 * xl never silently overwrites: two sources that resolve to one path are a
 * hard error rather than a race whose winner depends on traversal order.
 * @param {readonly object[]} plans - plans from {@link planSource}.
 * @returns {object[]} one record per conflicting path, with its owners.
 */
export function detectConflicts(plans) {
  /** @type {Map<string, string[]>} */
  const owners = new Map()
  for (const plan of plans) {
    for (const output of plan.outputs) {
      const key = output.path
      const list = owners.get(key) ?? []
      list.push(`${plan.src} (${plan.target})`)
      owners.set(key, list)
    }
  }
  const conflicts = []
  for (const [path, list] of owners) {
    if (list.length > 1) conflicts.push({ path, owners: list })
  }
  return conflicts.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}
