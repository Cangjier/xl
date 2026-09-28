/**
 * The `xl` Host service: the standardized xl operations exposed to any
 * consumer in the same composition.
 *
 * The service is the seam. The `xl_*` tools are one consumer (an agent), and
 * the `xl` command line is another; neither reimplements planning, the cache,
 * or the artifact contract.
 *
 * @module dsh-xl/plugin/service
 */

import { resolve } from 'node:path'
import {
  contextFor,
  deepMerge,
  emitArtifacts,
  listTargets,
  loadConfig,
  runBuild,
  runCheck,
  runPlan,
  verifyArtifacts,
} from '../core/index.js'

/**
 * Create the `xl` service.
 * @param {object} options - service options.
 * @param {string | null} [options.workspaceRoot] - default working directory for requests that name none.
 * @param {readonly string[]} [options.defaultTargets] - targets used when neither the request nor `xl.json` names one.
 * @param {boolean} [options.verifyOnEmit] - whether `emit` verifies before writing when the caller is silent.
 * @param {string} [options.cacheDir] - cache root override; `xl.json` and `XL_CACHE_DIR` still win.
 * @returns {object} the service.
 */
export function createXlService(options = {}) {
  /**
   * Resolve the working directory of one request.
   * @param {string | undefined} requested - a caller-supplied directory.
   * @returns {string} the absolute working directory.
   */
  const cwdOf = (requested) => {
    if (typeof requested === 'string' && requested.trim() !== '') return resolve(requested)
    if (typeof options.workspaceRoot === 'string' && options.workspaceRoot.trim() !== '') {
      return resolve(options.workspaceRoot)
    }
    return process.cwd()
  }

  /**
   * Load the configuration for one working directory.
   *
   * The row's `cacheDir` is a deployment default; `xl.json` and
   * `XL_CACHE_DIR` outrank it, so it is merged underneath the file.
   * @param {string} cwd - working directory.
   * @returns {object} the loaded configuration and its source file.
   */
  const configFor = (cwd) => {
    const loaded = loadConfig(cwd)
    if (typeof options.cacheDir !== 'string' || options.cacheDir === '') return loaded
    return { ...loaded, config: deepMerge({ build: { cacheDir: options.cacheDir } }, loaded.config) }
  }

  /**
   * Translate a request into the command-line option document the core reads.
   * @param {object} request - the request.
   * @returns {object} the option document.
   */
  const cliOf = (request) => {
    const cli = {
      flat: request.flat === true,
      force: request.force === true,
      dryRun: request.dryRun === true,
      cache: request.cache !== false,
      stdout: request.stdout === true,
      clean: request.clean === true,
    }
    const targets = request.targets ?? options.defaultTargets
    if (Array.isArray(targets) && targets.length > 0) cli.targets = targets
    if (typeof request.out === 'string' && request.out !== '') cli.out = request.out
    if (request.layout === 'file' || request.layout === 'type') cli.layout = request.layout
    if (request.naming === 'idiomatic' || request.naming === 'preserve') cli.naming = request.naming
    if (Array.isArray(request.ignore) && request.ignore.length > 0) cli.ignore = request.ignore
    if (typeof request.strict === 'boolean') cli.strict = request.strict
    if (typeof request.maxWarnings === 'number') cli.maxWarnings = request.maxWarnings
    if (typeof request.verify === 'boolean') cli.verify = request.verify
    return cli
  }

  return {
    /**
     * Resolve one request's working directory.
     * @param {string} [requested] - a caller-supplied directory.
     * @returns {string} the absolute working directory.
     */
    cwd: cwdOf,

    /**
     * List every known target for one working directory.
     * @param {object} [request] - the request.
     * @param {string} [request.cwd] - working directory.
     * @returns {object[]} target descriptors.
     */
    targets(request = {}) {
      const cwd = cwdOf(request.cwd)
      return listTargets(configFor(cwd).config)
    },

    /**
     * Run the static checks.
     * @param {object} [request] - the request.
     * @returns {object} the check result.
     */
    check(request = {}) {
      return runCheck({ cwd: cwdOf(request.cwd), paths: request.paths ?? [], cli: cliOf(request) })
    },

    /**
     * Plan every source × target output without producing anything.
     * @param {object} [request] - the request.
     * @returns {object} the plan result.
     */
    plan(request = {}) {
      return runPlan({ cwd: cwdOf(request.cwd), paths: request.paths ?? [], cli: cliOf(request) })
    },

    /**
     * Run a build. The `ts` target produces files; every other target is
     * planned only, because generation belongs to an agent.
     * @param {object} [request] - the request.
     * @returns {object} the build result.
     */
    build(request = {}) {
      return runBuild({ cwd: cwdOf(request.cwd), paths: request.paths ?? [], cli: cliOf(request) })
    },

    /**
     * The standardized generation context for one source × target.
     * @param {object} request - the request.
     * @param {string} request.source - POSIX source path.
     * @param {string} request.target - target language.
     * @returns {object} the context.
     */
    context(request) {
      return contextFor({
        cwd: cwdOf(request.cwd),
        source: request.source,
        target: request.target,
        options: optionBag(request),
        config: configFor(cwdOf(request.cwd)).config,
      })
    },

    /**
     * The cached previous product for one source × target.
     * @param {object} request - the request.
     * @returns {object} the cache record.
     */
    cache(request) {
      const cwd = cwdOf(request.cwd)
      const loaded = configFor(cwd)
      const opened = contextFor({
        cwd,
        source: request.source,
        target: request.target,
        options: optionBag(request),
        config: loaded.config,
      })
      const plan = opened.plan
      return {
        source: request.source,
        target: opened.resolved.target.name,
        reusable: plan?.reuse?.reusable === true,
        reason: plan?.reuse?.reason ?? null,
        fingerprint: plan?.fingerprint ?? null,
        promptHash: opened.context.promptHash,
        previous: opened.context.previous,
        outputs: opened.context.outputs,
      }
    },

    /**
     * Verify proposed products without writing.
     * @param {object} request - the request.
     * @returns {object} the verdict.
     */
    verify(request) {
      const cwd = cwdOf(request.cwd)
      return verifyArtifacts({
        cwd,
        source: request.source,
        target: request.target,
        files: request.files ?? [],
        options: optionBag(request),
        config: configFor(cwd).config,
      })
    },

    /**
     * Verify and write generated products with the xl header and cache.
     * @param {object} request - the request.
     * @returns {object} the emit result.
     */
    emit(request) {
      const cwd = cwdOf(request.cwd)
      const verify = request.verify ?? options.verifyOnEmit !== false
      return emitArtifacts({
        cwd,
        source: request.source,
        target: request.target,
        files: request.files ?? [],
        options: { ...optionBag(request), verify },
        config: configFor(cwd).config,
        model: request.model,
      })
    },
  }
}

/**
 * The planning subset of a request, in the shape `resolveArtifactRequest`
 * expects.
 * @param {object} request - the request.
 * @returns {object} the option bag.
 */
function optionBag(request) {
  return {
    out: request.out,
    layout: request.layout,
    naming: request.naming,
    flat: request.flat,
    force: request.force,
    verify: request.verify,
    cacheVersions: request.cacheVersions,
    noCache: request.cache === false,
    ignore: request.ignore,
  }
}
