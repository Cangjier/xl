/**
 * The non-ts channel's standardized operations: what an agent asks xl to do
 * around generation, and nothing about how the agent generates.
 *
 * Three operations, in the order an agent uses them:
 *
 * 1. {@link contextFor} — read the source and everything the target language
 *    needs to be generated from: the `.xl.md` text, the structural contract,
 *    the resolved override sections of this file and its dependencies, and the
 *    previous product to extend rather than rewrite.
 * 2. {@link verifyArtifacts} — check proposed content against the contract
 *    without touching the disk.
 * 3. {@link emitArtifacts} — verify, then write each file under the planned
 *    path with the xl header and fingerprint, archive the version it replaced,
 *    and record the result in the cache.
 *
 * @module xl/core/artifact
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BuildCache } from './cache.js'
import { checkWorkspace, languageContext, planWorkspace, prepareWorkspace } from './build.js'
import { cacheRoot } from './config.js'
import { countBySeverity, diag } from './diagnostics.js'
import { XL_VERSION } from './emit-ts.js'
import {
  fingerprintArtifact,
  fingerprintPrompt,
  fingerprintSource,
  isArtifact,
  renderHeader,
} from './header.js'
import { resolveLayout, resolveTarget } from './targets.js'
import { structureSummary, verifyStructure } from './verify.js'

/**
 * Load one source with its parsed document and dependency index.
 * @param {object} input - the request.
 * @param {string} input.cwd - working directory.
 * @param {string} input.source - POSIX source path.
 * @returns {object} the prepared workspace and the source entry.
 * @throws {Error} when the source cannot be read.
 */
export function loadEntry({ cwd, source }) {
  const prepared = prepareWorkspace({ cwd, paths: [source] })
  const entry = prepared.entries.find(item => item.src === source)
  if (entry === undefined) {
    const failure = prepared.diagnostics.find(item => item.severity === 'error')
    throw new Error(failure === undefined
      ? `xl cannot read "${source}"`
      : `xl cannot read "${source}": ${failure.msg}`)
  }
  return { prepared, entry, dependencies: prepared.dependencies.get(source) }
}

/**
 * Resolve the target descriptor and build options for one request.
 * @param {object} input - the request.
 * @param {string} input.cwd - working directory.
 * @param {string} input.target - requested target language.
 * @param {object} [input.options] - partially resolved build options.
 * @param {object} [input.config] - merged configuration.
 * @returns {{target: object, options: object, config: object}} the resolved request.
 */
export function resolveArtifactRequest({ cwd, target, options = {}, config = {} }) {
  const descriptor = resolveTarget(target, config)
  return {
    target: descriptor,
    config,
    options: {
      out: options.out ?? config.build?.out ?? null,
      flat: options.flat === true,
      layout: resolveLayout(descriptor, options.layout),
      naming: options.naming ?? config.build?.naming ?? 'idiomatic',
      force: options.force === true,
      verify: options.verify !== false,
      header: config.build?.header !== false,
      cacheVersions: options.cacheVersions ?? config.build?.cacheVersions ?? 5,
      noCache: options.noCache === true,
      checkIgnore: new Set(options.ignore ?? []),
    },
  }
}

/**
 * Build the generation context for one source × target.
 * @param {object} input - the request.
 * @param {string} input.cwd - working directory.
 * @param {string} input.source - POSIX source path.
 * @param {string} input.target - target language.
 * @param {object} [input.options] - build options.
 * @param {object} [input.config] - merged configuration.
 * @param {object} [input.env] - environment snapshot.
 * @returns {object} the context, its plan, and the parsed source.
 */
export function contextFor({ cwd, source, target, options = {}, config = {}, env = process.env }) {
  const resolved = resolveArtifactRequest({ cwd, target, options, config })
  const { prepared, entry } = loadEntry({ cwd, source })
  const cache = openCache({ cwd, config, env, options: resolved.options })
  const plans = planWorkspace(prepared, { targets: [resolved.target], options: resolved.options, cache, cwd })
  const plan = plans[0]
  const previous = resolved.options.noCache ? null : cache.latestArchive(source, resolved.target.ext)
  const context = {
    source,
    target: resolved.target.name,
    channel: resolved.target.channel,
    layout: plan?.layout ?? resolved.options.layout,
    outputs: plan?.outputs ?? [],
    text: entry.text,
    summary: structureSummary(entry.doc),
    language: languageContext(entry.doc, resolved.target, prepared, source),
    dependencies: (prepared.dependencies.get(source)?.documents ?? []).map(document => ({
      path: document.src,
      text: document.text,
      summary: structureSummary(document.doc),
    })),
    previous: previous === null
      ? null
      : { version: previous.version, path: previous.path, text: previous.text },
  }
  context.promptHash = fingerprintPrompt(JSON.stringify({
    summary: context.summary,
    language: context.language,
    dependencies: context.dependencies.map(item => item.summary),
    layout: context.layout,
    naming: resolved.options.naming,
  }))
  const diagnostics = checkWorkspace(prepared, {
    targets: [resolved.target],
    ignore: resolved.options.checkIgnore,
  })
  return { context, plan, prepared, entry, diagnostics, resolved }
}

/**
 * Open the cache store for a working directory.
 * @param {object} input - the request.
 * @param {string} input.cwd - working directory.
 * @param {object} input.config - merged configuration.
 * @param {object} input.env - environment snapshot.
 * @param {object} input.options - resolved build options.
 * @returns {BuildCache} the loaded cache.
 */
function openCache({ cwd, config, env, options }) {
  const cache = new BuildCache({
    cwd,
    root: cacheRoot(cwd, env, config),
    versions: options.cacheVersions ?? 5,
  })
  if (options.noCache !== true) cache.load()
  return cache
}

/**
 * Verify proposed products against the source's structural contract without
 * writing anything.
 * @param {object} input - the request.
 * @param {string} input.cwd - working directory.
 * @param {string} input.source - POSIX source path.
 * @param {string} input.target - target language.
 * @param {readonly object[]} input.files - proposed products with `path` and `content`.
 * @param {object} [input.options] - build options.
 * @param {object} [input.config] - merged configuration.
 * @param {object} [input.env] - environment snapshot.
 * @returns {object} the verdict, per-file issues, and the planned paths.
 */
export function verifyArtifacts({ cwd, source, target, files, options = {}, config = {}, env = process.env }) {
  const opened = contextFor({ cwd, source, target, options, config, env })
  const planned = opened.context.outputs
  const byPath = new Map(files.map(file => [normalizePath(file.path), file.content]))
  const unexpected = [...byPath.keys()].filter(path => !planned.some(output => output.path === path))
  const issues = []
  for (const output of planned) {
    const content = byPath.get(output.path)
    if (content === undefined) {
      issues.push({ path: output.path, issues: ['no content was supplied for this planned output'] })
      continue
    }
    const verdict = verifyStructure(opened.entry.doc, content, { only: new Set(output.names) })
    if (!verdict.ok) issues.push({ path: output.path, issues: verdict.issues })
  }
  return {
    ok: issues.length === 0 && unexpected.length === 0,
    issues,
    unexpected,
    planned: planned.map(output => output.path),
  }
}

/**
 * Write generated products with the xl header, fingerprint, archive, and cache.
 * @param {object} input - the request.
 * @param {string} input.cwd - working directory.
 * @param {string} input.source - POSIX source path.
 * @param {string} input.target - target language.
 * @param {readonly object[]} input.files - products with `path` and `content`.
 * @param {object} [input.options] - build options.
 * @param {object} [input.config] - merged configuration.
 * @param {object} [input.env] - environment snapshot.
 * @param {string} [input.model] - model id stamped into the header.
 * @returns {object} the emit result.
 */
export function emitArtifacts({ cwd, source, target, files, options = {}, config = {}, env = process.env, model }) {
  const opened = contextFor({ cwd, source, target, options, config, env })
  const { entry, resolved, context } = opened
  const errors = opened.diagnostics.filter(item => item.severity === 'error')
  if (errors.length > 0) {
    return {
      ok: false,
      written: [],
      skipped: [],
      diagnostics: errors,
      planned: context.outputs.map(output => output.path),
    }
  }

  const byPath = new Map(files.map(file => [normalizePath(file.path), file.content]))
  const planned = context.outputs
  const unexpected = [...byPath.keys()].filter(path => !planned.some(output => output.path === path))
  if (unexpected.length > 0) {
    return {
      ok: false,
      written: [],
      skipped: [],
      diagnostics: unexpected.map(path => diag({
        code: 'E2001',
        file: source,
        line: 1,
        msg: `"${path}" is not a planned output of ${source} for target "${resolved.target.name}"; planned: ${planned.map(output => output.path).join(', ')}`,
      })),
      planned: planned.map(output => output.path),
    }
  }

  const fingerprint = fingerprintSource(entry.text)
  const cache = openCache({ cwd, config, env, options: resolved.options })
  const diagnostics = []
  const written = []
  const skipped = []

  for (const output of planned) {
    const content = byPath.get(output.path)
    if (content === undefined) {
      diagnostics.push(diag({
        code: 'E4002',
        file: source,
        line: 1,
        msg: `planned output "${output.path}" was not supplied`,
      }))
      skipped.push(output.path)
      continue
    }
    if (resolved.options.verify) {
      const verdict = verifyStructure(entry.doc, content, { only: new Set(output.names) })
      if (!verdict.ok) {
        diagnostics.push(...verdict.issues.map(issue => diag({
          code: 'E4002',
          file: source,
          line: 1,
          msg: `${output.path}: ${issue}`,
        })))
        skipped.push(output.path)
        continue
      }
    }
    const absolute = join(cwd, output.path)
    if (existsSync(absolute) && !resolved.options.force && !isArtifact(readText(absolute))) {
      diagnostics.push(diag({
        code: 'E2001',
        file: source,
        line: 1,
        msg: `output conflict: ${output.path} exists and is not an xl artifact (pass force to overwrite)`,
      }))
      skipped.push(output.path)
      continue
    }
    if (cache.versions > 0) cache.archive(source, output.path)
    const header = resolved.options.header
      ? `${renderHeader({
        sourcePath: source,
        fingerprint,
        target: resolved.target.name,
        version: XL_VERSION,
        comment: resolved.target.comment,
        model,
        promptHash: context.promptHash,
      })}\n\n`
      : ''
    const text = `${header}${content.replace(/\r\n?/g, '\n').replace(/\n*$/, '')}\n`
    try {
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, text, 'utf8')
    } catch (error) {
      diagnostics.push(diag({
        code: 'E2002',
        file: source,
        line: 1,
        msg: `cannot write ${output.path}: ${error instanceof Error ? error.message : String(error)}`,
      }))
      skipped.push(output.path)
      continue
    }
    written.push(output.path)
  }

  if (written.length === planned.length && resolved.options.noCache !== true) {
    cache.set(source, resolved.target.name, {
      fingerprint,
      out: written,
      outHash: fingerprintArtifact(written.map(path => readText(join(cwd, path))).join('\u0000')),
      ...model === undefined ? {} : { model },
      promptHash: context.promptHash,
    })
    cache.save()
  }

  const counts = countBySeverity(diagnostics)
  return {
    ok: written.length === planned.length && counts.errors === 0,
    written,
    skipped,
    diagnostics,
    planned: planned.map(output => output.path),
    fingerprint,
    promptHash: context.promptHash,
  }
}

/**
 * Normalize a caller-supplied path to POSIX without a leading `./`.
 * @param {string} path - the path.
 * @returns {string} the normalized path.
 */
function normalizePath(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Read a file as text, returning the empty string when unreadable.
 * @param {string} path - file path.
 * @returns {string} the text.
 */
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
