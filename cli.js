/**
 * The `xl` application row entry point. The bundle patch mounts this subpath
 * only in the profile named `xl`.
 *
 * @module dsh-xl/cli
 */

export { apply, inject, internals, name } from './src/plugin/cli.js'
export { parseArgs, optionTable, validateOptions, HELP_TEXT, COMMANDS } from './src/plugin/args.js'
