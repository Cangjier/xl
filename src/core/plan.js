/**
 * Output planning: which files one source produces for one target, and which
 * planned paths collide (xl-cli §3.5).
 *
 * The layout rule, stated once: the effective output root is `--out`, then
 * `build.out`, then the working directory. A `file`-layout target keeps the
 * source's relative directory under that root; a `type`-layout target adds the
 * target-language segment in front of it and emits one file per type plus one
 * module file for the module-level declarations.
 *
 * @module xl/core/plan
 */

import { LAYOUT_TYPE, MODULE_FILE_SUFFIX, typeFileBaseName } from './targets.js'
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
 * Plan one source file for one target.
 * @param {object} doc - parsed document.
 * @param {string} sourceRel - POSIX source path relative to the working directory.
 * @param {object} target - target descriptor from `resolveTarget`.
 * @param {object} options - planning options.
 * @param {string | null} [options.out] - output root.
 * @param {boolean} [options.flat] - whether `--flat` discards the source directory.
 * @param {'file' | 'type'} [options.layout] - resolved layout.
 * @param {'idiomatic' | 'preserve'} [options.naming] - naming policy.
 * @returns {object} the plan: `outputs` with `path`, `base`, `kind`, and `names`.
 */
export function planSource(doc, sourceRel, target, options) {
  const layout = options.layout ?? target.layout
  const naming = options.naming ?? 'idiomatic'
  const root = outputRoot(options.out)
  const directory = sourceDirectory(sourceRel, options.flat === true)
  const base = sourceBaseName(sourceRel)

  if (layout !== LAYOUT_TYPE) {
    return {
      src: sourceRel,
      target: target.name,
      channel: target.channel,
      layout: 'file',
      ext: target.ext,
      outputs: [{
        path: joinPath([root, directory, `${base}${target.ext}`]),
        base,
        kind: 'file',
        names: declaredNames(doc.decls),
      }],
    }
  }

  const targetRoot = joinPath([root, target.name])
  const outputs = []
  const moduleDecls = doc.decls.filter(decl => MODULE_KINDS.has(decl.kind))
  const moduleNames = declaredNames(moduleDecls)
  if (moduleDecls.length > 0) {
    const moduleBase = typeFileBaseName(`${base}${MODULE_FILE_SUFFIX}`, target.name, naming)
    outputs.push({
      path: joinPath([targetRoot, directory, `${moduleBase}${target.ext}`]),
      base: moduleBase,
      kind: 'module',
      names: moduleNames,
    })
  }
  for (const decl of doc.decls) {
    if (MODULE_KINDS.has(decl.kind)) continue
    const typeBase = typeFileBaseName(decl.name, target.name, naming, decl.kind)
    outputs.push({
      path: joinPath([targetRoot, directory, `${typeBase}${target.ext}`]),
      base: typeBase,
      kind: 'type',
      names: [decl.name],
    })
  }
  return {
    src: sourceRel,
    target: target.name,
    channel: target.channel,
    layout: 'type',
    ext: target.ext,
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
