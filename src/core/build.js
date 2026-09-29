/**
 * Workspace orchestration: scan, parse, check, plan, and produce.
 *
 * Two channels, exactly as xl-cli §3 describes them:
 *
 * * `ts` is a **direct** channel. xl prints the artifact itself, writes it with
 *   its header and fingerprint, and never touches the network.
 * * every other target is a **plan** channel inside this plugin. xl reports the
 *   output paths, the structural contract, the language context, and the cached
 *   previous version; the generation itself is done by a DSH agent that calls
 *   the `xl_*` tools. No subprocess and no model call happens here.
 *
 * @module xl/core/build
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BuildCacheSet } from './cache.js'
import { cacheRoot, loadConfig, mergeEnv, resolveBuildOptions } from './config.js'
import { checkDeclaredTargets, checkDocument } from './check.js'
import { countBySeverity, dedupeDiagnostics, diag, sortDiagnostics } from './diagnostics.js'
import { XL_VERSION, printTypeScriptFile } from './emit-ts.js'
import { fingerprintSource, isArtifact, parseArtifactHeader, renderHeader } from './header.js'
import { parseXlMd } from './parse.js'
import { detectConflicts, planSource, resolveOutput } from './plan.js'
import { collectSources, readIgnorePatterns } from './scan.js'
import { loadSource } from './source.js'
import { UsageError, canonicalLang, resolveTargets, typeFileBaseName } from './targets.js'
import { toPosix } from './text.js'
import { structureSummary } from './verify.js'

/**
 * Load every input and its transitive `# dependencies` documents.
 * @param {object} input - the workspace input.
 * @param {string} input.cwd - working directory.
 * @param {readonly string[]} input.paths - raw path arguments.
 * @param {readonly string[]} [input.ignore] - `.xlignore` patterns.
 * @returns {object} the prepared workspace.
 * @throws {UsageError} when no input matches.
 */
export function prepareWorkspace({ cwd, paths, ignore }) {
  const patterns = ignore ?? readIgnorePatterns(cwd)
  const sources = collectSources(paths, cwd, { ignore: patterns })
  /** @type {Map<string, object>} */
  const documentCache = new Map()
  /** @type {object[]} */
  const diagnostics = []
  /** @type {object[]} */
  const entries = []
  /** @type {Map<string, object>} */
  const dependencies = new Map()

  /** Load and parse one file, memoized by its absolute path. */
  const loadDocument = (relPath) => {
    if (documentCache.has(relPath)) return documentCache.get(relPath)
    const loaded = loadSource(cwd, relPath)
    if (loaded.diagnostics.length > 0) {
      const record = { src: relPath, text: loaded.text, doc: null, diagnostics: loaded.diagnostics }
      documentCache.set(relPath, record)
      return record
    }
    const parsed = parseXlMd(loaded.text, relPath)
    const record = { src: relPath, text: loaded.text, doc: parsed.doc, diagnostics: parsed.diagnostics }
    documentCache.set(relPath, record)
    return record
  }

  for (const src of sources) {
    const record = loadDocument(src)
    if (record.doc === null) {
      diagnostics.push(...record.diagnostics)
      continue
    }
    entries.push(record)
  }

  for (const entry of entries) {
    const info = resolveDependencies(entry, loadDocument)
    dependencies.set(entry.src, info)
    diagnostics.push(...entry.diagnostics, ...info.problems)
  }

  return { cwd, sources, entries, dependencies, diagnostics, documentCache }
}

/**
 * Resolve one document's `# dependencies` imports against the filesystem.
 * @param {object} entry - the parsed source entry.
 * @param {Function} loadDocument - memoized loader.
 * @returns {{kinds: Map<string, string>, problems: object[], documents: object[]}} the resolved index.
 */
function resolveDependencies(entry, loadDocument) {
  const kinds = new Map()
  const problems = []
  const documents = []
  const base = dirname(entry.src)
  for (const record of entry.doc.dependencies?.imports ?? []) {
    const targetRel = toPosix(join(base === '.' ? '' : base, record.from))
    const loaded = loadDocument(targetRel)
    if (loaded.doc === null) {
      problems.push(diag({
        code: 'E1006',
        file: entry.src,
        line: record.line,
        msg: `dependency "${record.from}" cannot be read: ${loaded.diagnostics[0]?.msg ?? 'unknown problem'}`,
      }))
      continue
    }
    documents.push(loaded)
    // `# statement` declares no name, so it exports nothing to import.
    const declared = new Map(
      loaded.doc.decls
        .filter(decl => decl.kind !== 'statement')
        .map(decl => [decl.name, decl.kind]),
    )
    for (const name of record.names) {
      const kind = declared.get(name.name)
      if (kind === undefined) {
        problems.push(diag({
          code: 'E1006',
          file: entry.src,
          line: record.line,
          msg: `"${name.name}" is not a top-level declaration of "${record.from}"`,
        }))
        continue
      }
      kinds.set(name.alias ?? name.name, kind)
    }
  }
  return { kinds, problems, documents }
}

/**
 * Run the semantic checker over a prepared workspace.
 * @param {object} prepared - a workspace from {@link prepareWorkspace}.
 * @param {object} input - check input.
 * @param {readonly object[]} input.targets - resolved target descriptors.
 * @param {ReadonlySet<string>} [input.ignore] - codes excluded from the result.
 * @returns {object[]} ordered, deduplicated diagnostics.
 */
export function checkWorkspace(prepared, { targets, ignore = new Set() }) {
  // Parsing happened while the workspace was prepared, so its diagnostics are
  // part of the result rather than something to recompute.
  const diagnostics = [...prepared.diagnostics]
  for (const entry of prepared.entries) {
    const deps = prepared.dependencies.get(entry.src)
    const documentDiagnostics = checkDocument({
      doc: entry.doc,
      file: entry.src,
      source: entry.text,
      targets,
      deps: deps === undefined ? undefined : { kinds: deps.kinds, problems: [] },
    })
    diagnostics.push(...documentDiagnostics)
    diagnostics.push(...checkDeclaredTargets(entry.doc, targets))
  }
  diagnostics.push(...crossFileDiagnostics(prepared))
  return sortDiagnostics(dedupeDiagnostics(diagnostics)).filter(item => !ignore.has(item.code))
}

/**
 * Report top-level type names declared in more than one file in this run
 * (`E1107`).
 * @param {object} prepared - a workspace.
 * @returns {object[]} diagnostics.
 */
function crossFileDiagnostics(prepared) {
  /** @type {Map<string, string[]>} */
  const owners = new Map()
  for (const entry of prepared.entries) {
    for (const decl of entry.doc.decls) {
      if (decl.kind !== 'enum' && decl.kind !== 'interface' && decl.kind !== 'class') continue
      const list = owners.get(decl.name) ?? []
      list.push(entry.src)
      owners.set(decl.name, list)
    }
  }
  const diagnostics = []
  for (const entry of prepared.entries) {
    for (const decl of entry.doc.decls) {
      const list = owners.get(decl.name) ?? []
      if (list.length < 2 || list[0] !== entry.src) continue
      diagnostics.push(diag({
        code: 'E1107',
        file: entry.src,
        line: decl.line,
        msg: `type "${decl.name}" is also declared in ${list.slice(1).join(', ')}`,
      }))
    }
  }
  return diagnostics
}

/**
 * Build the plan for every source × target pair.
 * @param {object} prepared - a workspace.
 * @param {object} input - planning input.
 * @param {readonly object[]} input.targets - resolved target descriptors.
 * @param {object} input.options - resolved build options.
 * @param {BuildCacheSet} [input.cache] - the per-language cache stores, used to report reuse.
 * @param {string} [input.cwd] - working directory for the reuse decision.
 * @returns {object[]} one plan per source × target.
 */
export function planWorkspace(prepared, { targets, options, cache, cwd }) {
  const plans = []
  for (const entry of prepared.entries) {
    for (const target of targets) {
      const plan = planSource(entry.doc, entry.src, target, {
        out: options.out,
        flat: options.flat === true,
        naming: options.naming,
      })
      plan.summary = structureSummary(entry.doc)
      plan.context = languageContext(entry.doc, target, prepared, entry.src)
      plan.fingerprint = fingerprintSource(entry.text)
      plan.reuse = reuseDecision({
        cwd: cwd ?? prepared.cwd,
        plan,
        target,
        fingerprint: plan.fingerprint,
        force: options.force === true,
        clean: options.clean === true,
      })
      // One previous version per extension: a multi-part target (C++ `.h` and
      // `.cpp`) keeps its two histories side by side, and a single-part target
      // reports exactly the pointer it always did. No text is read here — the
      // plan only needs to name the file the generator should extend.
      const extensions = [...new Set(plan.outputs.map(output => output.ext))]
      const previous = cache === undefined ? [] : cache.for(target).latestArchives(entry.src, extensions, { text: false })
      if (previous.length > 0) {
        plan.previous = previous.map(item => ({
          part: plan.outputs.find(output => output.ext === item.ext)?.part ?? null,
          ext: item.ext,
          version: item.version,
          path: item.path,
        }))
      }
      plans.push(plan)
    }
  }
  return plans
}

/**
 * The language context handed to a non-ts generator: the namespace note, the
 * target-language override sections of this file and its dependencies, and the
 * cross-file imports (xl-cli §3.4, prompt section 4).
 * @param {object} doc - parsed document.
 * @param {object} target - target descriptor.
 * @param {object} prepared - the workspace.
 * @param {string} src - the source path.
 * @returns {object} the context.
 */
export function languageContext(doc, target, prepared, src) {
  const sections = []
  const collect = (owner, list) => {
    for (const section of list ?? []) {
      if (section.lang !== target.name) continue
      sections.push({
        owner,
        code: section.blocks.map(block => block.rawBody.trim()).filter(text => text !== '').join('\n\n'),
        prose: section.prose,
      })
    }
  }
  collect('# dependencies', doc.dependencies?.sections)
  collect('# namespace', doc.namespace?.sections)
  let statements = 0
  for (const decl of doc.decls) {
    // A `# statement` declares no name, so it is identified by position: that is
    // enough for a generator to line its `## <lang>` sections up (xl-syntax §17).
    let owner = `${decl.kind} ${decl.name}`
    if (decl.kind === 'statement') {
      statements += 1
      owner = `# statement ${statements}`
    }
    collect(owner, decl.sections)
    for (const member of decl.members ?? []) {
      collect(`${owner}.${member.name}`, member.sections)
      for (const accessor of member.accessors ?? []) {
        collect(`${owner}.${member.name}.${accessor.kind}`, accessor.sections)
      }
    }
  }
  const dependencyDocuments = prepared.dependencies.get(src)?.documents ?? []
  const imports = []
  for (const dependency of dependencyDocuments) {
    for (const decl of dependency.doc.decls) {
      if (decl.kind === 'statement') continue
      imports.push({ from: dependency.src, name: decl.name, kind: decl.kind })
    }
  }
  return {
    namespace: doc.namespace === null ? null : { name: doc.namespace.name, note: doc.namespace.prose },
    sections,
    imports,
  }
}

/**
 * Decide whether an artifact set can be reused without regenerating.
 *
 * The documented rule (xl-cli §3.6): every planned product exists, carries an
 * xl header, names this target, and records the current source fingerprint.
 * @param {object} input - the decision input.
 * @param {string} input.cwd - working directory.
 * @param {object} input.plan - the plan.
 * @param {object} input.target - target descriptor.
 * @param {string} input.fingerprint - current source fingerprint.
 * @param {boolean} input.force - whether `--force` discards the decision.
 * @param {boolean} [input.clean] - whether `--clean` discards the decision.
 * @returns {{reusable: boolean, reason: string | null}} the decision.
 */
function reuseDecision({ cwd, plan, target, fingerprint, force, clean }) {
  if (force) return { reusable: false, reason: 'forced' }
  if (clean) return { reusable: false, reason: 'cleaned' }
  for (const output of plan.outputs) {
    const absolute = resolveOutput(cwd, output.path)
    if (!existsSync(absolute)) return { reusable: false, reason: `missing artifact ${output.path}` }
    const header = parseArtifactHeader(readArtifact(absolute))
    if (header === null) return { reusable: false, reason: `${output.path} has no xl header` }
    if (header.target !== target.name) return { reusable: false, reason: `${output.path} targets ${header.target}` }
    if (header.sha256 !== fingerprint) return { reusable: false, reason: `${output.path} is stale` }
  }
  return { reusable: true, reason: null }
}

/**
 * Read a file as text, returning the empty string when unreadable.
 * @param {string} path - file path.
 * @returns {string} the text.
 */
function readArtifact(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Run a build.
 * @param {object} input - the build request.
 * @param {string} input.cwd - working directory.
 * @param {readonly string[]} [input.paths] - raw path arguments.
 * @param {object} [input.config] - an already-loaded configuration document.
 * @param {object} [input.env] - environment snapshot.
 * @param {object} [input.cli] - parsed command-line options.
 * @returns {object} the build result.
 * @throws {UsageError} for usage errors (exit 2) and for unreadable input.
 */
export function runBuild(input) {
  const cwd = input.cwd
  const env = input.env ?? process.env
  const loaded = input.config === undefined ? loadConfig(cwd, env) : { config: input.config, file: null }
  const merged = mergeEnv(loaded.config, env)
  const options = resolveBuildOptions({ config: merged, cli: input.cli ?? {} })
  const targets = resolveTargets(options.targets, merged)
  const prepared = prepareWorkspace({ cwd, paths: input.paths ?? [] })
  return buildPrepared({ cwd, prepared, targets, options, config: merged, env, loaded })
}

/** Codes the artifact layer reports; `--ignore` cannot silence them. */
const UNIGNORABLE_CODES = new Set(['E2001', 'E2002', 'E2003'])

/**
 * Produce the artifacts for a prepared workspace.
 * @param {object} input - the build input.
 * @param {string} input.cwd - working directory.
 * @param {object} input.prepared - a prepared workspace.
 * @param {readonly object[]} input.targets - resolved target descriptors.
 * @param {object} input.options - resolved build options.
 * @param {object} input.config - merged configuration.
 * @param {object} input.env - environment snapshot.
 * @param {object} input.loaded - the loaded configuration document and its file.
 * @returns {object} the build result.
 */
export function buildPrepared({ cwd, prepared, targets, options, config, env, loaded }) {
  const started = Date.now()
  // A write failure or an output conflict is not a rule the author can waive,
  // so those codes stay out of the ignore set: the run must still fail.
  const ignore = new Set([...(options.checkIgnore ?? [])].filter(code => !UNIGNORABLE_CODES.has(code)))
  const diagnostics = checkWorkspace(prepared, { targets, ignore })
  const counts = countBySeverity(diagnostics, ignore)
  const result = {
    ok: false,
    cwd,
    configFile: loaded?.file ?? null,
    targets: targets.map(target => target.name),
    files: [],
    plans: [],
    diagnostics,
    written: 0,
    skipped: 0,
    planned: 0,
    errors: counts.errors,
    warnings: counts.warnings,
    ms: 0,
    stdout: [],
    exitCode: 0,
    failed: false,
  }
  if (counts.errors > 0) {
    result.ms = Date.now() - started
    result.exitCode = 1
    return result
  }

  const cache = new BuildCacheSet({
    cwd,
    versions: options.cacheVersions,
    enabled: !options.noCache,
    rootOf: name => cacheRoot(cwd, env, config, { out: options.out, target: name }),
  })
  const plans = planWorkspace(prepared, { targets, options, cache, cwd })
  result.plans = plans

  const conflicts = detectConflicts(plans)
  for (const conflict of conflicts) {
    for (const owner of conflict.owners) {
      diagnostics.push(diag({
        code: 'E2001',
        file: owner.split(' (')[0],
        line: 1,
        msg: `output conflict: ${conflict.path} is planned ${conflict.owners.length} times by ${conflict.owners.join(', ')}`,
      }))
    }
  }
  if (conflicts.length > 0) {
    result.diagnostics = sortDiagnostics(dedupeDiagnostics(diagnostics))
    const recount = countBySeverity(result.diagnostics, ignore)
    result.errors = recount.errors
    result.warnings = recount.warnings
    result.ms = Date.now() - started
    result.exitCode = 1
    return result
  }

  // `--clean` removes the products of this run before anything is produced, so
  // the run starts from the source alone. Each removed product is archived
  // first, so a clean build still keeps the history the plan channel reads
  // ("the implementation to extend"). A dry run or a stdout run produces
  // nothing and therefore deletes nothing.
  if (options.clean === true && options.dryRun !== true && options.stdout !== true) {
    cleanPlannedOutputs({ cwd, plans, cache })
  }

  for (const plan of plans) {
    const entry = prepared.entries.find(item => item.src === plan.src)
    if (entry === undefined) continue
    const target = targets.find(item => item.name === plan.target)
    if (target === undefined) continue
    const record = processPlan({
      cwd, plan, target, entry, options, cache: cache.for(plan.target), result,
    })
    result.files.push(record)
  }

  if (options.dryRun !== true && options.stdout !== true && !options.noCache) {
    for (const plan of plans) {
      if (plan.channel !== 'direct') continue
      const outputs = result.files.filter(file => file.src === plan.src && file.target === plan.target)
      const written = outputs.flatMap(file => file.out)
      if (written.length === 0) continue
      const content = written.map(path => readArtifact(resolveOutput(cwd, path))).join('\u0000')
      cache.for(plan.target).set(plan.src, plan.target, {
        fingerprint: plan.fingerprint,
        out: written,
        outHash: fingerprintSource(content),
      })
    }
    cache.save()
  }

  result.diagnostics = sortDiagnostics(dedupeDiagnostics(diagnostics))
  const finalCounts = countBySeverity(result.diagnostics, ignore)
  result.errors = finalCounts.errors
  result.warnings = finalCounts.warnings
  // A write failure or an output conflict is never maskable by `--ignore`: the
  // diagnostic may be ignored for counting, but the run did not do its job.
  result.ok = result.errors === 0 && !result.failed
  result.ms = Date.now() - started
  result.exitCode = result.ok ? 0 : 1
  return result
}

/**
 * Archive and delete every planned output that exists, for `--clean`.
 * @param {object} input - the clean input.
 * @param {string} input.cwd - working directory.
 * @param {readonly object[]} input.plans - the plans of this run.
 * @param {import('./cache.js').BuildCacheSet} input.cache - the per-language stores.
 * @returns {void}
 */
function cleanPlannedOutputs({ cwd, plans, cache }) {
  for (const plan of plans) {
    const store = cache.for(plan.target)
    for (const output of plan.outputs) {
      const absolute = resolveOutput(cwd, output.path)
      if (!existsSync(absolute)) continue
      store.archive(plan.src, output.path)
      try {
        rmSync(absolute)
      } catch {
        // A file that cannot be removed is reported by the write below.
      }
    }
  }
}

/**
 * Produce or plan one source × target pair.
 * @param {object} input - the per-plan input.
 * @returns {object} the file record.
 */
function processPlan({ cwd, plan, target, entry, options, cache, result }) {
  if (plan.channel !== 'direct') {
    result.planned += 1
    return {
      src: plan.src,
      target: plan.target,
      channel: plan.channel,
      status: 'planned',
      out: plan.outputs.map(output => output.path),
      reason: plan.reuse.reusable ? 'cached' : plan.reuse.reason,
    }
  }
  if (plan.reuse.reusable && options.force !== true) {
    result.skipped += 1
    return {
      src: plan.src,
      target: plan.target,
      channel: 'direct',
      status: 'skipped',
      out: plan.outputs.map(output => output.path),
      reason: plan.reuse.reason ?? 'up to date',
    }
  }
  const artifact = printTypeScriptFile(entry.doc, {
    sourcePath: plan.src,
    fingerprint: plan.fingerprint,
    header: options.header,
    renderHeader: fields => renderHeader({ ...fields, version: XL_VERSION, comment: target.comment }),
  })
  const output = plan.outputs[0]
  // `plan.outputs[0]` is the whole artifact here: the direct channel is
  // single-part by construction, since only `ts` uses it and `ts` declares
  // exactly one part.
  if (options.stdout === true) {
    result.stdout.push(artifact)
    return {
      src: plan.src,
      target: plan.target,
      channel: 'direct',
      status: 'generated',
      out: [output.path],
      reason: 'written to stdout',
    }
  }
  if (options.dryRun === true) {
    warnHandEdited({ cwd, plan, path: output.path, cache, result })
    return {
      src: plan.src,
      target: plan.target,
      channel: 'direct',
      status: 'planned',
      out: [output.path],
      reason: 'dry run',
    }
  }
  const absolute = resolveOutput(cwd, output.path)
  if (!options.force && existsSync(absolute)) {
    const existing = readArtifact(absolute)
    if (!isArtifact(existing)) {
      result.diagnostics.push(diag({
        code: 'E2001',
        file: plan.src,
        line: 1,
        msg: `output conflict: ${output.path} exists and is not an xl artifact (use --force to overwrite)`,
      }))
      result.errors += 1
      result.failed = true
      return {
        src: plan.src,
        target: plan.target,
        channel: 'direct',
        status: 'failed',
        out: [output.path],
        reason: 'output conflict',
      }
    }
  }
  warnHandEdited({ cwd, plan, path: output.path, cache, result })
  // Archive the version being replaced before the write; the newest archived
  // version is what the non-ts channel offers as the implementation to extend.
  cache.archive(plan.src, output.path)
  try {
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, artifact, 'utf8')
  } catch (error) {
    result.diagnostics.push(diag({
      code: 'E2002',
      file: plan.src,
      line: 1,
      msg: `cannot write ${output.path}: ${error instanceof Error ? error.message : String(error)}`,
    }))
    result.errors += 1
    result.failed = true
    return {
      src: plan.src,
      target: plan.target,
      channel: 'direct',
      status: 'failed',
      out: [output.path],
      reason: 'write failed',
    }
  }
  result.written += 1
  return {
    src: plan.src,
    target: plan.target,
    channel: 'direct',
    status: 'generated',
    out: [output.path],
    reason: null,
  }
}

/**
 * Warn when a product was changed after xl wrote it (`E2003`).
 *
 * The header records the *source* fingerprint, so a hand edit leaves it
 * untouched. The evidence is the artifact content hash recorded in the cache:
 * when the file on disk no longer hashes to it, the product was modified
 * outside xl and is about to be overwritten.
 * @param {object} input - the check input.
 * @param {string} input.cwd - working directory.
 * @param {object} input.plan - the plan being produced.
 * @param {string} input.path - the produced path.
 * @param {object} input.cache - the cache store.
 * @param {object} input.result - the build result collecting diagnostics.
 */
function warnHandEdited({ cwd, plan, path, cache, result }) {
  const absolute = resolveOutput(cwd, path)
  if (!existsSync(absolute)) return
  const existing = readArtifact(absolute)
  if (!isArtifact(existing)) return
  const recorded = cache.entry(plan.src, plan.target)
  if (recorded === undefined || typeof recorded.outHash !== 'string') return
  if (fingerprintSource(existing) === recorded.outHash) return
  if (result.diagnostics.some(item => item.code === 'E2003' && item.file === plan.src)) return
  result.diagnostics.push(diag({
    code: 'E2003',
    file: plan.src,
    line: 1,
    msg: `${path} was modified after xl wrote it and will be overwritten`,
  }))
  result.warnings += 1
}

/**
 * Run a check-only invocation.
 * @param {object} input - the check request.
 * @param {string} input.cwd - working directory.
 * @param {readonly string[]} [input.paths] - raw path arguments.
 * @param {object} [input.cli] - parsed command-line options.
 * @param {object} [input.env] - environment snapshot.
 * @returns {object} the check result.
 */
export function runCheck(input) {
  const cwd = input.cwd
  const env = input.env ?? process.env
  const loaded = loadConfig(cwd, env)
  const config = mergeEnv(loaded.config, env)
  const options = resolveBuildOptions({ config, cli: input.cli ?? {} })
  const targets = resolveTargets(options.targets, config)
  const prepared = prepareWorkspace({ cwd, paths: input.paths ?? [] })
  const ignore = options.checkIgnore ?? new Set()
  const diagnostics = checkWorkspace(prepared, { targets, ignore })
  const counts = countBySeverity(diagnostics, ignore)
  const strict = input.cli?.strict === true || options.checkStrict === true
  const maxWarnings = input.cli?.maxWarnings ?? options.checkMaxWarnings
  const overBudget = typeof maxWarnings === 'number' && counts.warnings > maxWarnings
  const ok = counts.errors === 0 && !(strict && counts.warnings > 0) && !overBudget
  return {
    ok,
    cwd,
    files: prepared.sources.length,
    diagnostics,
    errors: counts.errors,
    warnings: counts.warnings,
    exitCode: ok ? 0 : 1,
  }
}

/**
 * Plan-only invocation, the shape both `xl build -t <other>` and the
 * `xl_plan` tool use.
 * @param {object} input - the plan request.
 * @param {string} input.cwd - working directory.
 * @param {readonly string[]} [input.paths] - raw path arguments.
 * @param {object} [input.cli] - parsed command-line options.
 * @param {object} [input.env] - environment snapshot.
 * @returns {object} the plan result.
 */
export function runPlan(input) {
  const cwd = input.cwd
  const env = input.env ?? process.env
  const loaded = loadConfig(cwd, env)
  const config = mergeEnv(loaded.config, env)
  const options = resolveBuildOptions({ config, cli: input.cli ?? {} })
  const targets = resolveTargets(options.targets, config)
  const prepared = prepareWorkspace({ cwd, paths: input.paths ?? [] })
  const ignore = options.checkIgnore ?? new Set()
  const diagnostics = checkWorkspace(prepared, { targets, ignore })
  const counts = countBySeverity(diagnostics, ignore)
  if (counts.errors > 0) {
    return { ok: false, cwd, plans: [], diagnostics, errors: counts.errors, warnings: counts.warnings, exitCode: 1 }
  }
  const cache = new BuildCacheSet({
    cwd,
    versions: options.cacheVersions,
    rootOf: name => cacheRoot(cwd, env, config, { out: options.out, target: name }),
  })
  const plans = planWorkspace(prepared, { targets, options, cache, cwd })
  return {
    ok: true,
    cwd,
    plans,
    diagnostics,
    errors: counts.errors,
    warnings: counts.warnings,
    exitCode: 0,
  }
}

/**
 * Resolve the effective target list for a request without running a build.
 * @param {object} input - the request.
 * @param {string} input.cwd - working directory.
 * @param {readonly string[]} [input.targets] - requested languages.
 * @param {object} [input.env] - environment snapshot.
 * @returns {{targets: object[], config: object}} resolved targets and the configuration.
 */
export function resolveRequestedTargets(input) {
  const env = input.env ?? process.env
  const loaded = loadConfig(input.cwd, env)
  const config = mergeEnv(loaded.config, env)
  const requested = input.targets !== undefined && input.targets.length > 0
    ? input.targets
    : (config.build?.target ?? ['ts'])
  const list = Array.isArray(requested) ? requested : [requested]
  return { targets: resolveTargets(list, config), config }
}

export { UsageError, canonicalLang, resolveTargets, typeFileBaseName, structureSummary }
