/**
 * The `xl` Host plugin: it publishes the `xl` service and registers the
 * model-facing `xl_*` tools.
 *
 * The plugin is a plain ESM function plugin with no harness import, so a
 * profile can install it without a build step and without a dependency edge on
 * the harness packages it composes with.
 *
 * @module dsh-xl/plugin
 */

import { createXlService } from './service.js'
import { registerTools } from './tools.js'

/** Stable Cordis plugin name. */
export const name = 'xl'

/** Services required before the tools can be registered. */
export const inject = ['tools']

/** Service name this plugin provides. */
export const XL_SERVICE = 'xl'

/**
 * Validate and normalize the row's config.
 *
 * The Loader cannot validate this plugin's config for it, because validating
 * would require a harness dependency; misconfiguration therefore fails loud
 * here, at activation, instead of surfacing as a confusing tool error later.
 * @param {object} raw - the row's `config`.
 * @returns {object} the normalized config.
 * @throws {TypeError} when a field has the wrong type.
 */
export function normalizeConfig(raw) {
  const config = raw ?? {}
  const workspaceRoot = config.workspaceRoot ?? null
  if (workspaceRoot !== null && typeof workspaceRoot !== 'string') {
    throw new TypeError('xl: config.workspaceRoot must be a string or null')
  }
  const cacheDir = config.cacheDir ?? '.xl'
  if (typeof cacheDir !== 'string' || cacheDir === '') {
    throw new TypeError('xl: config.cacheDir must be a non-empty string')
  }
  const defaultTargets = config.defaultTargets ?? ['ts']
  if (!Array.isArray(defaultTargets) || defaultTargets.some(target => typeof target !== 'string')) {
    throw new TypeError('xl: config.defaultTargets must be an array of target names')
  }
  const verifyOnEmit = config.verifyOnEmit ?? true
  if (typeof verifyOnEmit !== 'boolean') {
    throw new TypeError('xl: config.verifyOnEmit must be a boolean')
  }
  return {
    workspaceRoot,
    cacheDir,
    defaultTargets: [...defaultTargets],
    verifyOnEmit,
  }
}

/**
 * Mount the `xl` service and its tools.
 * @param {object} ctx - plugin context carrying the tool registry.
 * @param {object} rawConfig - the row's config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const service = createXlService({
    workspaceRoot: config.workspaceRoot,
    defaultTargets: config.defaultTargets,
    verifyOnEmit: config.verifyOnEmit,
    cacheDir: config.cacheDir,
  })
  ctx.provide(XL_SERVICE, service)
  registerTools(ctx, service)
}

export { createXlService } from './service.js'
