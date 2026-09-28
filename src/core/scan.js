/**
 * Input discovery: files, directories, and globs into the sorted, deduplicated
 * `*.xl.md` input list (xl-cli §3.2).
 *
 * @module dsh-xl/core/scan
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { isArtifact } from './header.js'
import { UsageError } from './targets.js'
import { toPosix } from './text.js'

/** Directory names never scanned, regardless of `.xlignore`. */
export const SCAN_EXCLUDES = new Set(['node_modules', '.git', 'dist', 'build', '.xl'])

/** The source-file suffix xl recognizes. */
export const SOURCE_SUFFIX = '.xl.md'

/**
 * Expand glob braces into separate patterns.
 * @param {string} pattern - glob pattern.
 * @returns {string[]} brace-free patterns.
 */
export function expandBraces(pattern) {
  const open = pattern.indexOf('{')
  if (open < 0) return [pattern]
  let depth = 0
  for (let index = open; index < pattern.length; index += 1) {
    if (pattern[index] === '{') depth += 1
    else if (pattern[index] === '}') {
      depth -= 1
      if (depth === 0) {
        const head = pattern.slice(0, open)
        const tail = pattern.slice(index + 1)
        const alternatives = splitAlternatives(pattern.slice(open + 1, index))
        return alternatives.flatMap(alternative => expandBraces(`${head}${alternative}${tail}`))
      }
    }
  }
  return [pattern]
}

/**
 * Split a brace group body on top-level commas.
 * @param {string} body - brace group body.
 * @returns {string[]} the alternatives.
 */
function splitAlternatives(body) {
  const out = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '{') depth += 1
    else if (body[index] === '}') depth -= 1
    else if (body[index] === ',' && depth === 0) {
      out.push(body.slice(start, index))
      start = index + 1
    }
  }
  out.push(body.slice(start))
  return out
}

/**
 * Compile one glob pattern to a regular expression over POSIX relative paths.
 * @param {string} pattern - glob pattern.
 * @returns {RegExp} the compiled expression.
 */
export function globToRegExp(pattern) {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:[^/]+/)*'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end > index) {
        source += pattern.slice(index, end + 1)
        index = end
        continue
      }
    }
    source += char.replace(/[.+^${}()|\\\]]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

/**
 * Whether a POSIX relative path matches any pattern.
 * @param {string} relPath - path relative to the search root.
 * @param {readonly string[]} patterns - glob patterns.
 * @returns {boolean} whether a pattern matches.
 */
export function matchesAny(relPath, patterns) {
  return patterns.some((pattern) => {
    for (const expanded of expandBraces(pattern)) {
      if (globToRegExp(expanded).test(relPath)) return true
      // A directory pattern also selects everything under it.
      if (globToRegExp(`${expanded.replace(/\/+$/, '')}/**`).test(relPath)) return true
    }
    return false
  })
}

/**
 * Read `.xlignore` patterns from a search root.
 * @param {string} cwd - search root.
 * @returns {string[]} the patterns.
 */
export function readIgnorePatterns(cwd) {
  try {
    return readFileSync(join(cwd, '.xlignore'), 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'))
  } catch {
    return []
  }
}

/**
 * Whether a relative path is excluded by the fixed list or by `.xlignore`.
 * @param {string} relPath - POSIX path relative to the search root.
 * @param {readonly string[]} ignore - `.xlignore` patterns.
 * @returns {boolean} whether the path is excluded.
 */
export function isIgnored(relPath, ignore) {
  const segments = relPath.split('/')
  for (const segment of segments.slice(0, -1)) {
    if (SCAN_EXCLUDES.has(segment)) return true
  }
  return matchesAny(relPath, ignore)
}

/**
 * Recursively collect every `*.xl.md` file under a directory.
 * @param {string} root - absolute directory.
 * @param {string} cwd - search root used for relative paths.
 * @param {string[]} into - accumulator of relative POSIX paths.
 * @param {readonly string[]} ignore - `.xlignore` patterns.
 */
function walk(root, cwd, into, ignore) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absolute = join(root, entry.name)
    const relPath = toPosix(relative(cwd, absolute))
    if (entry.isDirectory()) {
      if (SCAN_EXCLUDES.has(entry.name)) continue
      if (isIgnored(`${relPath}/`, ignore)) continue
      walk(absolute, cwd, into, ignore)
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.endsWith(SOURCE_SUFFIX)) continue
    if (isIgnored(relPath, ignore)) continue
    into.push(relPath)
  }
}

/**
 * Expand the invocation's path arguments into the input list.
 *
 * Every returned path is POSIX-separated and relative to `cwd`; the list is
 * deduplicated and sorted by code unit so plans, diagnostics, and events are
 * stable across platforms (xl-cli §3.2).
 * @param {readonly string[]} paths - raw path arguments; empty means the whole workspace.
 * @param {string} cwd - working directory the invocation resolves against.
 * @param {object} [options] - discovery options.
 * @param {readonly string[]} [options.ignore] - `.xlignore` patterns; read from `cwd` when omitted.
 * @returns {string[]} the input list.
 * @throws {UsageError} `E0001` for a missing path, `E0002` when nothing matched.
 */
export function collectSources(paths, cwd, options = {}) {
  const ignore = options.ignore ?? readIgnorePatterns(cwd)
  const raw = paths.length === 0 ? ['.'] : [...paths]
  /** @type {string[]} */
  const collected = []

  for (const entry of raw) {
    const absolute = isAbsolute(entry) ? entry : resolve(cwd, entry)
    let stats
    try {
      stats = statSync(absolute)
    } catch {
      // A glob that matches nothing is a normal empty expansion; a literal
      // path that does not exist is a usage error.
      if (isGlob(entry)) continue
      throw new UsageError(`input path does not exist: ${entry}`, 'E0001')
    }
    if (stats.isDirectory()) {
      walk(absolute, cwd, collected, ignore)
      continue
    }
    if (!stats.isFile()) continue
    const relPath = toPosix(relative(cwd, absolute))
    if (isIgnored(relPath, ignore)) continue
    collected.push(relPath)
  }

  const unique = [...new Set(collected)]
    .filter(relPath => !isArtifact(safeRead(join(cwd, relPath))))
    .sort()

  if (unique.length === 0) {
    throw new UsageError('no *.xl.md input matched the given paths', 'E0002')
  }
  return unique
}

/**
 * Whether a path argument contains glob syntax.
 * @param {string} value - path argument.
 * @returns {boolean} whether the argument is a glob.
 */
export function isGlob(value) {
  return /[*?[{]/.test(value)
}

/**
 * Read a file as text, returning the empty string when unreadable.
 * @param {string} path - file path.
 * @returns {string} the file text, or the empty string.
 */
function safeRead(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
