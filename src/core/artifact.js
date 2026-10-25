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
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { BuildCacheSet } from './cache.js'
import { checkWorkspace, languageContext, planWorkspace, prepareWorkspace } from './build.js'
import { cacheRoot, DEFAULTS, mergeEnv } from './config.js'
import { countBySeverity, diag } from './diagnostics.js'
import { XL_VERSION } from './emit-ts.js'
import {
  fingerprintArtifact,
  fingerprintPrompt,
  fingerprintSource,
  isArtifact,
  parseArtifactHeader,
  renderHeader,
  stripArtifactHeader,
} from './header.js'
import { commentMarkerFor } from './parse.js'
import { resolveOutput } from './plan.js'
import { resolveTarget } from './targets.js'
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
      out: options.out ?? config.build?.out ?? DEFAULTS.out,
      flat: options.flat === true,
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
  const merged = mergeEnv(config, env)
  const resolved = resolveArtifactRequest({ cwd, target, options, config: merged })
  const { prepared, entry } = loadEntry({ cwd, source })
  const cache = openCache({ cwd, config: merged, env, options: resolved.options })
  const plans = planWorkspace(prepared, { targets: [resolved.target], options: resolved.options, cache, cwd })
  const plan = plans[0]
  const outputs = plan?.outputs ?? []
  // The archive family is keyed by source × extension, so a multi-part target
  // (C++ `.h` + `.cpp`) offers one previous version per part, not one per path.
  const archived = resolved.options.noCache ? [] : cache.for(resolved.target).latestArchives(source, outputs.map(output => output.ext))
  const byExtension = new Map(archived.map(item => [item.ext, item]))
  const previous = []
  const seenExtensions = new Set()
  for (const output of outputs) {
    if (seenExtensions.has(output.ext)) continue
    seenExtensions.add(output.ext)
    const item = byExtension.get(output.ext)
    if (item === undefined) continue
    previous.push({
      part: output.part,
      ext: output.ext,
      version: item.version,
      path: item.path,
      text: item.text,
    })
  }
  const context = {
    source,
    target: resolved.target.name,
    channel: resolved.target.channel,
    layout: plan?.layout ?? resolved.target.layout,
    parts: resolved.target.parts,
    outputs,
    text: entry.text,
    summary: structureSummary(entry.doc),
    language: languageContext(entry.doc, resolved.target, prepared, source),
    dependencies: (prepared.dependencies.get(source)?.documents ?? []).map(document => ({
      path: document.src,
      text: document.text,
      summary: structureSummary(document.doc),
    })),
    previous,
  }
  context.promptHash = fingerprintPrompt(JSON.stringify({
    summary: context.summary,
    language: context.language,
    dependencies: context.dependencies.map(item => item.summary),
    layout: context.layout,
    parts: context.parts.map(part => [part.role, part.ext, part.requires ?? null, part.scope ?? null]),
    naming: resolved.options.naming,
  }))
  const diagnostics = checkWorkspace(prepared, {
    targets: [resolved.target],
    ignore: resolved.options.checkIgnore,
  })
  return { context, plan, prepared, entry, diagnostics, resolved }
}

/**
 * Open the per-language cache stores for a working directory.
 * @param {object} input - the request.
 * @param {string} input.cwd - working directory.
 * @param {object} input.config - merged configuration.
 * @param {object} input.env - environment snapshot.
 * @param {object} input.options - resolved build options.
 * @returns {BuildCacheSet} the stores, opened lazily per target language.
 */
function openCache({ cwd, config, env, options }) {
  return new BuildCacheSet({
    cwd,
    versions: options.cacheVersions ?? 5,
    enabled: options.noCache !== true,
    rootOf: name => cacheRoot(cwd, env, config, { out: options.out, target: name }),
  })
}

/**
 * One submitted product, either supplied inline or adopted off the disk.
 *
 * `files[].content` is the inline form: the caller already holds the text and
 * pays for it in the tool call. `files[].from` is the disk form: the generator
 * wrote the product straight to a file, and `xl` reads it back, drops any
 * `@generated` header it carries, and submits the body. Exactly one of the two
 * is accepted, so a submission can never be ambiguous about its content.
 * @typedef {object} Submission
 * @property {string} path - planned output path, POSIX.
 * @property {string} content - the body to verify and write.
 * @property {string} [from] - the file it was read from, `cwd`-relative POSIX.
 */

/**
 * Turn a `files[]` list into submissions, reading the disk form.
 * @param {object} input - the request.
 * @param {string} input.cwd - working directory.
 * @param {string} input.source - POSIX source path.
 * @param {string} input.target - resolved target name.
 * @param {readonly object[]} input.files - entries with `path` and `content` or `from`.
 * @returns {{submissions: Submission[], diagnostics: object[]}} the submissions
 *   and the resolution diagnostics (a missing or unreadable `from`, an entry
 *   with both forms or neither, a header that names another product).
 */
function resolveSubmission({ cwd, source, target, files }) {
  const submissions = []
  const diagnostics = []
  for (const file of files) {
    const path = normalizePath(file?.path)
    const hasContent = typeof file?.content === 'string'
    const from = typeof file?.from === 'string' && file.from.trim() !== '' ? file.from : null
    if (hasContent && from !== null) {
      diagnostics.push(diag({
        code: 'E4004',
        file: source,
        line: 1,
        msg: `${path}: supply either content or from, not both`,
      }))
      continue
    }
    if (!hasContent && from === null) {
      diagnostics.push(diag({
        code: 'E4005',
        file: source,
        line: 1,
        msg: `${path}: no content was supplied for this planned output; give content or from`,
      }))
      continue
    }
    if (hasContent) {
      submissions.push({ path, content: file.content })
      continue
    }
    const absolute = isAbsolute(from) ? from : resolve(cwd, from)
    let text
    try {
      text = readFileSync(absolute, 'utf8')
    } catch (error) {
      diagnostics.push(diag({
        code: 'E4003',
        file: source,
        line: 1,
        msg: `cannot read files[].from "${normalizePath(from)}": ${error instanceof Error ? error.message : String(error)}`,
      }))
      continue
    }
    const reported = reportPath(cwd, from)
    const header = parseArtifactHeader(text)
    if (header !== null) {
      const namesAnother = !sameSource(cwd, header.sourcePath, source)
      const otherTarget = header.target !== '' && header.target !== target
      if (namesAnother || otherTarget) {
        diagnostics.push(diag({
          code: 'W4001',
          file: source,
          line: 1,
          msg: `${path}: the @generated header in "${reported}" names ${header.sourcePath} → ${header.target || '(no target)'}; the header is rewritten for ${source} → ${target}`,
        }))
      }
    }
    submissions.push({ path, content: stripArtifactHeader(text), from: reported })
  }
  return { submissions, diagnostics }
}

/**
 * Whether an artifact header's recorded source path names the source being
 * submitted. Header paths are relative to the working directory of the run that
 * wrote them, so both sides are resolved before they are compared.
 * @param {string} cwd - working directory of this request.
 * @param {string} headerPath - the path recorded in the header.
 * @param {string} source - the POSIX source path of this request.
 * @returns {boolean} whether they name the same file.
 */
function sameSource(cwd, headerPath, source) {
  const left = resolve(cwd, String(headerPath).trim())
  const right = resolve(cwd, source)
  return normalizePath(left) === normalizePath(right)
}

/**
 * A path as it should be reported: `cwd`-relative when it sits below the
 * working directory, POSIX elsewhere.
 * @param {string} cwd - working directory.
 * @param {string} path - the path to report.
 * @returns {string} the reported path.
 */
function reportPath(cwd, path) {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  const relativePath = relative(cwd, absolute)
  if (relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
    return normalizePath(relativePath)
  }
  return normalizePath(absolute)
}

/**
 * Verify proposed products against the source's structural contract without
 * writing anything.
 * @param {object} input - the request.
 * @param {string} input.cwd - working directory.
 * @param {string} input.source - POSIX source path.
 * @param {string} input.target - target language.
 * @param {readonly object[]} input.files - proposed products with `path` and `content` or `from`.
 * @param {object} [input.options] - build options.
 * @param {object} [input.config] - merged configuration.
 * @param {object} [input.env] - environment snapshot.
 * @returns {object} the verdict, per-file issues, the planned paths, and the
 *   warnings raised while resolving the submissions.
 */
export function verifyArtifacts({ cwd, source, target, files, options = {}, config = {}, env = process.env }) {
  const opened = contextFor({ cwd, source, target, options, config, env })
  const planned = opened.context.outputs
  const resolution = resolveSubmission({ cwd, source, target: opened.resolved.target.name, files })
  const errors = resolution.diagnostics.filter(item => item.severity === 'error')
  const byPath = new Map(resolution.submissions.map(submission => [submission.path, submission.content]))
  const unexpected = [...byPath.keys()].filter(path => !planned.some(output => output.path === path))
  const issues = errors.map(item => ({ path: normalizePath(item.file), issues: [item.msg] }))
  if (errors.length === 0) {
    for (const output of planned) {
      const content = byPath.get(output.path)
      if (content === undefined) {
        issues.push({ path: output.path, issues: ['no content was supplied for this planned output'] })
        continue
      }
      const verdict = verifyStructure(opened.entry.doc, content, {
        only: new Set(output.names),
        scope: output.scope,
      })
      if (!verdict.ok) issues.push({ path: output.path, issues: verdict.issues })
    }
  }
  return {
    ok: issues.length === 0 && unexpected.length === 0,
    issues,
    unexpected,
    planned: planned.map(output => output.path),
    warnings: resolution.diagnostics.filter(item => item.severity === 'warning'),
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
      adopted: [],
      diagnostics: errors,
      planned: context.outputs.map(output => output.path),
    }
  }

  const resolution = resolveSubmission({ cwd, source, target: resolved.target.name, files })
  const supplyErrors = resolution.diagnostics.filter(item => item.severity === 'error')
  const adopted = resolution.submissions.filter(submission => submission.from !== undefined).map(submission => submission.path)
  if (supplyErrors.length > 0) {
    return {
      ok: false,
      written: [],
      skipped: [],
      adopted,
      diagnostics: supplyErrors,
      planned: context.outputs.map(output => output.path),
    }
  }

  const byPath = new Map(resolution.submissions.map(submission => [submission.path, submission.content]))
  const planned = context.outputs
  const unexpected = [...byPath.keys()].filter(path => !planned.some(output => output.path === path))
  if (unexpected.length > 0) {
    return {
      ok: false,
      written: [],
      skipped: [],
      adopted,
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
  const store = cache.for(resolved.target)
  const diagnostics = [...resolution.diagnostics.filter(item => item.severity === 'warning')]
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
      const verdict = verifyStructure(entry.doc, content, {
        only: new Set(output.names),
        scope: output.scope,
      })
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
    const absolute = resolveOutput(cwd, output.path)
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
    if (store.versions > 0) store.archive(source, output.path)
    const header = resolved.options.header
      ? `${renderHeader({
        sourcePath: source,
        fingerprint,
        target: resolved.target.name,
        version: XL_VERSION,
        comment: commentMarkerFor(resolved.target.name, output.ext),
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
    store.set(source, resolved.target.name, {
      fingerprint,
      out: written,
      outHash: fingerprintArtifact(written.map(path => readText(resolveOutput(cwd, path))).join('\u0000')),
      ...model === undefined ? {} : { model },
      promptHash: context.promptHash,
    })
    store.save()
  }

  const counts = countBySeverity(diagnostics)
  return {
    ok: written.length === planned.length && counts.errors === 0,
    written,
    skipped,
    adopted,
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
