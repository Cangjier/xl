/**
 * `xl.json` discovery and option resolution.
 *
 * The precedence everywhere is **CLI argument > environment variable >
 * `xl.json` > built-in default** (xl-cli §3.1, §5).
 *
 * @module xl/core/config
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { cpus } from 'node:os'
import { outputRoot } from './plan.js'

/** Built-in defaults applied when neither the CLI, the environment, nor the config names a value. */
export const DEFAULTS = {
  targets: ['ts'],
  out: 'dist',
  naming: 'idiomatic',
  concurrency: Math.max(1, Math.min(4, cpus().length || 1)),
  verify: true,
  header: true,
  cacheVersions: 5,
  cacheDir: '.xl',
  specHint: null,
  checkIgnore: [],
  checkStrict: false,
  checkMaxWarnings: null,
}

/** Config file names probed in order. */
const CONFIG_NAMES = ['xl.json', 'xl.config.json']

/**
 * Deep-merge plain objects; arrays and scalars are replaced.
 * @param {object} base - lower-priority object.
 * @param {object} override - higher-priority object.
 * @returns {object} a new merged object.
 */
export function deepMerge(base, override) {
  const out = { ...base }
  for (const [key, value] of Object.entries(override ?? {})) {
    const existing = out[key]
    if (isPlainObject(existing) && isPlainObject(value)) out[key] = deepMerge(existing, value)
    else out[key] = value
  }
  return out
}

/**
 * Whether a value is a plain object.
 * @param {unknown} value - candidate.
 * @returns {boolean} whether the value is a non-array object.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Walk up from a directory looking for an xl configuration file.
 * @param {string} cwd - starting directory.
 * @returns {{path: string, document: object} | null} the file and its parsed document.
 */
export function findConfigFile(cwd) {
  let directory = resolve(cwd)
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) {
        const parsed = readJson(candidate)
        if (parsed !== null) return { path: candidate, document: parsed }
      }
    }
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const parsed = readJson(manifest)
      if (isPlainObject(parsed?.xl)) return { path: manifest, document: parsed.xl }
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

/**
 * Read and parse a JSON file, returning `null` for unreadable or malformed content.
 * @param {string} path - file path.
 * @returns {object | null} the parsed document.
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Load the effective configuration for a working directory.
 * @param {string} cwd - working directory the invocation resolves against.
 * @param {object} [env] - environment snapshot; defaults to `process.env`.
 * @returns {{config: object, file: string | null}} the merged document and its source file.
 */
export function loadConfig(cwd, env = process.env) {
  const explicit = env.XL_CONFIG
  let document = {}
  let file = null
  if (explicit !== undefined && explicit !== '') {
    const path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit)
    const parsed = readJson(path)
    if (parsed === null) throw new Error(`XL_CONFIG points at an unreadable or malformed file: ${path}`)
    document = parsed
    file = path
  } else {
    const found = findConfigFile(cwd)
    if (found !== null) {
      document = found.document
      file = found.path
    }
  }
  return { config: document, file }
}

/**
 * Environment-variable overrides (xl-cli §5).
 * @param {object} env - environment snapshot.
 * @returns {object} the override document.
 */
export function envConfig(env) {
  const out = { build: {}, check: {} }
  if (env.XL_TARGET !== undefined && env.XL_TARGET !== '') {
    out.build.target = env.XL_TARGET.split(',').map(part => part.trim()).filter(part => part !== '')
  }
  if (env.XL_OUT !== undefined && env.XL_OUT !== '') out.build.out = env.XL_OUT
  if (env.XL_TIMEOUT !== undefined && env.XL_TIMEOUT !== '') out.build.timeout = Number(env.XL_TIMEOUT)
  if (env.XL_CONCURRENCY !== undefined && env.XL_CONCURRENCY !== '') out.build.concurrency = Number(env.XL_CONCURRENCY)
  return out
}

/**
 * Cache root for one target language of a working directory.
 *
 * The cache lives beside the products it describes: every target gets its own
 * store under its own language directory (`dist/ts/.xl`, `dist/csharp/.xl`, …),
 * so one language's incremental state never has to be read to build another.
 *
 * `build.cacheDir` / `XL_CACHE_DIR` name the cache directory itself (default
 * `.xl`). A relative value keeps the language segment in front of it; an
 * absolute value is used verbatim and is therefore shared by every language,
 * which stays correct because `cache.json` is keyed by source × target and an
 * archive file name carries the target's extension.
 * @param {string} cwd - working directory.
 * @param {object} env - environment snapshot.
 * @param {object} config - merged configuration.
 * @param {object} [location] - where the cache belongs.
 * @param {string | null} [location.out] - effective output root; `undefined` uses the default root.
 * @param {string} [location.target] - canonical target language.
 * @returns {string} the absolute cache root.
 */
export function cacheRoot(cwd, env, config, { out, target } = {}) {
  const directory = env.XL_CACHE_DIR ?? config.build?.cacheDir ?? DEFAULTS.cacheDir
  if (isAbsolute(directory)) return directory
  const root = outputRoot(out === undefined ? DEFAULTS.out : out)
  return resolve(cwd, root, target ?? '', directory)
}

/**
 * Resolve the effective build options from every precedence layer.
 * @param {object} input - the layers.
 * @param {object} input.config - merged `xl.json` and environment document.
 * @param {object} input.cli - parsed command-line options.
 * @returns {object} the effective options.
 */
export function resolveBuildOptions({ config, cli }) {
  const build = config.build ?? {}
  const check = config.check ?? {}
  const targets = cli.targets !== undefined && cli.targets.length > 0
    ? cli.targets
    : Array.isArray(build.target) && build.target.length > 0
      ? build.target
      : typeof build.target === 'string' && build.target !== ''
        ? [build.target]
        : DEFAULTS.targets
  return {
    targets,
    out: cli.out ?? build.out ?? DEFAULTS.out,
    flat: cli.flat === true,
    naming: cli.naming ?? build.naming ?? DEFAULTS.naming,
    concurrency: cli.concurrency ?? build.concurrency ?? DEFAULTS.concurrency,
    verify: cli.verify ?? build.verify ?? DEFAULTS.verify,
    header: build.header !== false,
    cacheVersions: normalizeCacheVersions(build.cacheVersions),
    specHint: build.specHint ?? DEFAULTS.specHint,
    checkIgnore: new Set([...check.ignore ?? [], ...cli.ignore ?? []]),
    checkStrict: cli.strict ?? check.strict ?? DEFAULTS.checkStrict,
    checkMaxWarnings: cli.maxWarnings ?? check.maxWarnings ?? DEFAULTS.checkMaxWarnings,
    force: cli.force === true,
    noCache: cli.cache === false,
    clean: cli.clean === true,
    dryRun: cli.dryRun === true,
    stdout: cli.stdout === true,
  }
}

/**
 * Normalize `build.cacheVersions`; `false` and `0` disable the archive.
 * @param {unknown} value - configured value.
 * @returns {number} how many historical versions to keep.
 */
function normalizeCacheVersions(value) {
  if (value === false || value === 0) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULTS.cacheVersions
  return Math.floor(value)
}
