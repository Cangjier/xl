/**
 * The incremental cache and the historical-version archive (xl-cli §3.6).
 *
 * Two stores with different jobs:
 *
 * * `<cache root>/cache.json` records each source × target's fingerprint, the
 *   artifact paths it produced, and the artifact's own content hash, so a later
 *   run can detect a hand-edited product (`E2003`).
 * * `<cache root>/cache/<mirror>.<ext>.<N>` keeps recent products. The newest
 *   version is what the non-ts channel offers as "the implementation to build
 *   on", so a different version is a different generation input.
 *
 * @module dsh-xl/core/cache
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { XL_VERSION } from './emit-ts.js'
import { toPosix } from './text.js'

/** Serialized cache format version. */
const CACHE_FORMAT = '0.1.0'

/** Separator between the source and target halves of a cache key. */
const KEY_SEPARATOR = '\u0000'

/**
 * Cache and history store for one working directory.
 */
export class BuildCache {
  /**
   * @param {object} options - store locations.
   * @param {string} options.cwd - working directory the invocation resolves against.
   * @param {string} options.root - absolute cache root, normally `<cwd>/.xl`.
   * @param {number} options.versions - how many historical versions to keep; `0` disables the archive.
   */
  constructor({ cwd, root, versions }) {
    this.cwd = cwd
    this.root = root
    this.versions = versions
    this.file = join(root, 'cache.json')
    this.archiveRoot = join(root, 'cache')
    /** @type {Record<string, object>} */
    this.entries = {}
  }

  /**
   * Read the cache document. A missing or malformed file reads as empty: the
   * cache is an optimization, never a source of truth.
   * @returns {void}
   */
  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.entries === 'object') {
        this.entries = parsed.entries ?? {}
      }
    } catch {
      this.entries = {}
    }
  }

  /**
   * The recorded entry for one source × target pair.
   * @param {string} src - POSIX source path.
   * @param {string} target - canonical target name.
   * @returns {object | undefined} the entry, when one was recorded.
   */
  entry(src, target) {
    return this.entries[`${src}${KEY_SEPARATOR}${target}`]
  }

  /**
   * Record one produced artifact for a source × target pair.
   * @param {string} src - POSIX source path.
   * @param {string} target - canonical target name.
   * @param {object} value - recorded facts.
   * @param {string} value.fingerprint - source fingerprint.
   * @param {string[]} value.out - produced paths.
   * @param {string} value.outHash - hash of the produced content.
   * @param {string} [value.model] - model id recorded on the non-ts channel.
   * @param {string} [value.promptHash] - generation-context hash.
   * @returns {void}
   */
  set(src, target, value) {
    this.entries[`${src}${KEY_SEPARATOR}${target}`] = {
      ...value,
      at: new Date().toISOString(),
    }
  }

  /**
   * Forget one source × target pair.
   * @param {string} src - POSIX source path.
   * @param {string} target - canonical target name.
   * @returns {void}
   */
  forget(src, target) {
    delete this.entries[`${src}${KEY_SEPARATOR}${target}`]
  }

  /**
   * Write the cache document. Failure is contained: an unwritable cache must
   * not fail a build that already produced correct artifacts.
   * @returns {void}
   */
  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify({ version: CACHE_FORMAT, entries: this.entries }, null, 2)}\n`, 'utf8')
    } catch {
      // The cache is best-effort; the artifacts are already on disk.
    }
  }

  /**
   * Archive the artifact currently at `outPath` before it is overwritten.
   * @param {string} sourceRel - POSIX source path.
   * @param {string} outPath - produced path, relative to the working directory.
   * @returns {string | null} the archive path, or `null` when nothing was kept.
   */
  archive(sourceRel, outPath) {
    if (this.versions <= 0) return null
    const absolute = join(this.cwd, outPath)
    if (!existsSync(absolute)) return null
    let content
    try {
      content = readFileSync(absolute, 'utf8')
    } catch {
      return null
    }
    return this.archiveText(sourceRel, outPath, content)
  }

  /**
   * Store one product version under the archive root.
   * @param {string} sourceRel - POSIX source path.
   * @param {string} outPath - produced path, relative to the working directory.
   * @param {string} content - the product text.
   * @returns {string | null} the archive path, or `null` on failure.
   */
  archiveText(sourceRel, outPath, content) {
    if (this.versions <= 0) return null
    const mirror = toPosix(sourceRel).replace(/\.xl\.md$/, '')
    const slash = mirror.lastIndexOf('/')
    const directory = slash < 0 ? '' : mirror.slice(0, slash)
    const base = slash < 0 ? mirror : mirror.slice(slash + 1)
    const extension = extensionOf(outPath)
    const targetDir = join(this.archiveRoot, directory)
    try {
      mkdirSync(targetDir, { recursive: true })
      const index = this.nextArchiveIndex(targetDir, base, extension)
      const file = join(targetDir, `${base}${extension}.${index}`)
      writeFileSync(file, content, 'utf8')
      this.prune(targetDir, base, extension)
      return toPosix(file.startsWith(`${this.cwd}/`) || file.startsWith(`${this.cwd}\\`)
        ? file.slice(this.cwd.length + 1)
        : file)
    } catch {
      return null
    }
  }

  /**
   * The newest archived product for a source, if any.
   * @param {string} sourceRel - POSIX source path.
   * @param {string} extension - target extension, including the dot.
   * @returns {{version: number, path: string, text: string} | null} the newest version.
   */
  latestArchive(sourceRel, extension) {
    const mirror = toPosix(sourceRel).replace(/\.xl\.md$/, '')
    const slash = mirror.lastIndexOf('/')
    const directory = slash < 0 ? '' : mirror.slice(0, slash)
    const base = slash < 0 ? mirror : mirror.slice(slash + 1)
    const targetDir = join(this.archiveRoot, directory)
    const indices = this.archiveIndices(targetDir, base, extension)
    if (indices.length === 0) return null
    const version = indices[indices.length - 1]
    const file = join(targetDir, `${base}${extension}.${version}`)
    try {
      return { version, path: toPosix(file), text: readFileSync(file, 'utf8') }
    } catch {
      return null
    }
  }

  /**
   * Lowest free version index for one archive family.
   * @param {string} directory - absolute archive directory.
   * @param {string} base - archive base name.
   * @param {string} extension - target extension.
   * @returns {number} the index to write next.
   */
  nextArchiveIndex(directory, base, extension) {
    const indices = this.archiveIndices(directory, base, extension)
    return indices.length === 0 ? 1 : indices[indices.length - 1] + 1
  }

  /**
   * Existing version indices, in ascending numeric order.
   * @param {string} directory - absolute archive directory.
   * @param {string} base - archive base name.
   * @param {string} extension - target extension.
   * @returns {number[]} ascending indices.
   */
  archiveIndices(directory, base, extension) {
    let names
    try {
      names = readdirSync(directory)
    } catch {
      return []
    }
    const prefix = `${base}${extension}.`
    const indices = []
    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const suffix = name.slice(prefix.length)
      if (!/^\d+$/.test(suffix)) continue
      indices.push(Number(suffix))
    }
    return indices.sort((left, right) => left - right)
  }

  /**
   * Keep only the newest configured number of versions.
   * @param {string} directory - absolute archive directory.
   * @param {string} base - archive base name.
   * @param {string} extension - target extension.
   * @returns {void}
   */
  prune(directory, base, extension) {
    const indices = this.archiveIndices(directory, base, extension)
    const excess = indices.length - this.versions
    for (let index = 0; index < excess; index += 1) {
      try {
        rmSync(join(directory, `${base}${extension}.${indices[index]}`))
      } catch {
        // A missing historical file is already the intended state.
      }
    }
  }
}

/**
 * Extension of a path including the leading dot.
 * @param {string} path - produced path.
 * @returns {string} the extension, or the empty string.
 */
function extensionOf(path) {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = slash < 0 ? path : path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot)
}

export { CACHE_FORMAT, XL_VERSION }
