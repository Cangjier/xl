/**
 * The `xl` application row: it turns the profile's own command line into
 * `xl build`, `xl check`, and `xl targets`, and it is the only consumer that
 * writes to the process streams.
 *
 * It is disabled outside the profile named `xl` by the bundle patch, because a
 * profile's command line is parsed by exactly one application plugin.
 *
 * @module xl/plugin/cli
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWriter, fileLine, planLine } from './console.js'
import { HELP_TEXT, USAGE_TEXT, XL_CLI_VERSION, parseArgs, validateOptions } from './args.js'

/** Stable Cordis plugin name. */
export const name = 'xl-cli'

/** The launcher's command line and the `xl` service this row drives. */
export const inject = ['cmdlineArgs', 'xl']

/** Process streams, substitutable by tests. */
export const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Exit code for a usage error (xl-cli §3.8). */
const EXIT_USAGE = 2

/**
 * Mount the `xl` command line.
 * @param {object} ctx - plugin context carrying the launcher's command line.
 * @returns {void}
 */
export function apply(ctx) {
  const argv = ctx.get('cmdlineArgs')?.get() ?? []
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('xl-cli: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io = { out: internals.stdout, err: internals.stderr }
  void run(ctx, argv, io, exit)
}

/**
 * Run one invocation and request process exit.
 * @param {object} ctx - plugin context.
 * @param {readonly string[]} argv - the invocation's inner arguments.
 * @param {{out: object, err: object}} io - process streams.
 * @param {(code: number) => void} exit - bounded exit request.
 * @returns {Promise<void>} resolves once exit has been requested.
 */
async function run(ctx, argv, io, exit) {
  try {
    await ctx.get('loader')?.await()
    const parsed = parseArgs(argv)
    const writer = createWriter({
      io,
      quiet: parsed.options.quiet === true,
      verbose: parsed.options.verbose === true,
      json: parsed.options.json === true,
      format: parsed.options.format,
    })

    if (parsed.options.version === true) {
      io.out.write(`${XL_CLI_VERSION}\n`)
      exit(0)
      return
    }
    if (parsed.options.help === true || parsed.command === null) {
      if (parsed.command === null && parsed.options.help !== true) {
        io.err.write(`${USAGE_TEXT}\n`)
        exit(EXIT_USAGE)
        return
      }
      io.out.write(HELP_TEXT)
      exit(0)
      return
    }

    const errors = [...parsed.errors, ...validateOptions(parsed.options)]
    if (errors.length > 0) {
      for (const message of errors) io.err.write(`error: ${message}\n`)
      io.err.write(`${USAGE_TEXT}\n`)
      exit(EXIT_USAGE)
      return
    }
    exit(await dispatch(ctx, parsed, writer, io))
  } catch (error) {
    const usage = error !== null && typeof error === 'object' && error.name === 'UsageError'
    io.err.write(`xl: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(usage ? EXIT_USAGE : 1)
  }
}

/**
 * Run the parsed command.
 * @param {object} ctx - plugin context.
 * @param {object} parsed - the parsed invocation.
 * @param {object} writer - the console writer.
 * @param {{out: object, err: object}} io - process streams.
 * @returns {Promise<number>} the process exit code.
 */
async function dispatch(ctx, parsed, writer, io) {
  const service = ctx.get('xl')
  if (service === undefined) throw new Error('xl-cli: the xl service is not mounted')
  const request = requestOf(parsed)
  switch (parsed.command) {
    case 'check':
      return runCheckCommand(service, request, writer)
    case 'targets':
      return runTargetsCommand(service, request, writer, io)
    default:
      return runBuildCommand(service, request, writer, io, parsed.options)
  }
}

/** Options that exist for the documented command line but have no effect here. */
const INERT_OPTIONS = [
  ['harness', '--harness'],
  ['harnessProfile', '--harness-profile'],
  ['timeout', '--timeout'],
  ['retries', '--retries'],
  ['keepGoing', '--keep-going'],
  ['concurrency', '--concurrency'],
]

/**
 * Note the options this build accepts but does not act on.
 *
 * They belong to the design in which xl spawned a harness itself; generation
 * now belongs to the calling agent, so silently accepting them would be
 * misleading.
 * @param {object} options - the parsed options.
 * @param {object} writer - the console writer.
 */
function noteInertOptions(options, writer) {
  const unused = INERT_OPTIONS.filter(([key]) => options[key] !== undefined).map(([, flag]) => flag)
  if (unused.length === 0) return
  writer.debug(`${unused.join(' ')} accepted but unused: this build never invokes a harness; generation belongs to the calling agent.`)
}

/**
 * Translate parsed options into a service request.
 * @param {object} parsed - the parsed invocation.
 * @returns {object} the request.
 */
function requestOf(parsed) {
  const options = parsed.options
  const request = { paths: parsed.paths }
  if (typeof options.cwd === 'string') request.cwd = options.cwd
  if (Array.isArray(options.targets)) request.targets = options.targets
  if (typeof options.out === 'string') request.out = options.out
  if (typeof options.naming === 'string') request.naming = options.naming
  if (options.flat === true) request.flat = true
  if (options.force === true) request.force = true
  if (options.cache === false) request.cache = false
  if (options.dryRun === true) request.dryRun = true
  if (options.stdout === true) request.stdout = true
  if (options.clean === true) request.clean = true
  if (options.strict === true) request.strict = true
  if (typeof options.maxWarnings === 'number') request.maxWarnings = options.maxWarnings
  if (Array.isArray(options.ignore)) request.ignore = options.ignore
  if (options.verify === false) request.verify = false
  return request
}

/**
 * Run `xl check`.
 * @param {object} service - the `xl` service.
 * @param {object} request - the request.
 * @param {object} writer - the console writer.
 * @returns {number} the exit code.
 */
function runCheckCommand(service, request, writer) {
  const result = service.check(request)
  const sources = new Map()
  const linesOf = (file) => {
    if (!sources.has(file)) {
      sources.set(file, readLines(join(result.cwd, file)))
    }
    return sources.get(file)
  }
  for (const item of result.diagnostics) writer.diagnostic(item, linesOf(item.file))
  writer.event('check.end', {
    ok: result.ok,
    files: result.files,
    errors: result.errors,
    warnings: result.warnings,
  })
  if (!writer.ndjson) {
    writer.info(`${result.ok ? '✔' : '✖'} ${result.errors} error(s), ${result.warnings} warning(s) in ${result.files} file(s)`)
  }
  return result.exitCode
}

/**
 * Read a file's lines for the pretty diagnostic caret.
 * @param {string} path - absolute file path.
 * @returns {string[] | undefined} the lines, or `undefined` when unreadable.
 */
function readLines(path) {
  try {
    return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').split('\n')
  } catch {
    return undefined
  }
}

/**
 * Run `xl targets`.
 * @param {object} service - the `xl` service.
 * @param {object} request - the request.
 * @param {object} writer - the console writer.
 * @param {{out: object, err: object}} io - process streams.
 * @returns {number} the exit code.
 */
function runTargetsCommand(service, request, writer, io) {
  const targets = service.targets(request)
  if (writer.ndjson) {
    for (const target of targets) {
      writer.event('target', { name: target.name, channel: target.channel, ext: target.ext, layout: target.layout })
    }
    return 0
  }
  for (const target of targets) {
    io.out.write(`${target.name}\t${target.channel === 'direct' ? 'direct' : 'plan'}\t${target.ext}\t${target.layout}\n`)
  }
  return 0
}

/**
 * Run `xl build`.
 * @param {object} service - the `xl` service.
 * @param {object} request - the request.
 * @param {object} writer - the console writer.
 * @param {{out: object, err: object}} io - process streams.
 * @param {object} options - the parsed options, used to report inert ones.
 * @returns {number} the exit code.
 */
function runBuildCommand(service, request, writer, io, options) {
  noteInertOptions(options, writer)
  const result = service.build(request)
  writer.event('build.start', { targets: result.targets, files: result.files.length })
  for (const plan of result.plans) {
    writer.event('file.plan', {
      src: plan.src,
      target: plan.target,
      channel: plan.channel,
      out: plan.outputs.map(output => output.path),
    })
    writer.debug(planLine(plan))
  }
  for (const file of result.files) {
    writer.event('file.done', {
      src: file.src,
      target: file.target,
      channel: file.channel,
      status: file.status,
      out: file.out,
    })
    if (file.status === 'planned' && file.channel !== 'direct') {
      writer.info(`${fileLine(file)} — generate it in a DSH session with the xl_* tools`)
      continue
    }
    writer.info(fileLine(file))
  }
  for (const item of result.diagnostics) {
    if (item.severity === 'warning') writer.event('build.warn', { msg: item.msg, src: item.file, target: '' })
    else writer.event('build.error', { msg: item.msg, src: item.file, target: '' })
    writer.diagnostic(item)
  }
  if (result.stdout.length > 0) {
    io.out.write(result.stdout.join('\n'))
    if (!result.stdout[result.stdout.length - 1].endsWith('\n')) io.out.write('\n')
  }
  writer.event('build.end', {
    ok: result.ok,
    written: result.written,
    skipped: result.skipped,
    planned: result.planned,
    warnings: result.warnings,
    errors: result.errors,
    ms: result.ms,
  })
  if (!writer.ndjson) {
    const parts = [`${result.written} written`, `${result.skipped} skipped`]
    if (result.planned > 0) parts.push(`${result.planned} planned`)
    parts.push(`${result.errors} error(s)`)
    writer.info(`${result.ok ? '✔' : '✖'} build done in ${(result.ms / 1000).toFixed(1)}s — ${parts.join(', ')}`)
    if (result.planned > 0) {
      writer.info('planned outputs belong to a DSH session: call xl_context, then xl_emit.')
    }
  }
  return result.exitCode
}
