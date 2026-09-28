/**
 * Shared test helpers: throwaway workspaces and a minimal Cordis context.
 *
 * @module dsh-xl/tests/helpers
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { readdirSync } from 'node:fs'
import { toPosix } from '../src/core/text.js'

/**
 * Create a temporary workspace populated with the given files.
 * @param {Record<string, string>} files - relative path to content.
 * @returns {string} the workspace root.
 */
export function makeWorkspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-xl-'))
  writeFiles(root, files)
  return root
}

/**
 * Write files into an existing directory, creating parent directories.
 * @param {string} root - workspace root.
 * @param {Record<string, string>} files - relative path to content.
 * @returns {void}
 */
export function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const absolute = join(root, rel)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  }
}

/**
 * Read every file under a workspace, keyed by POSIX relative path.
 * @param {string} root - workspace root.
 * @returns {Record<string, string>} relative path to content.
 */
export function readWorkspace(root) {
  const out = {}
  for (const rel of walk(root)) out[rel] = readFileSync(join(root, rel), 'utf8')
  return out
}

/**
 * List every file under a directory, as POSIX relative paths.
 * @param {string} root - directory.
 * @param {string} [base] - recursion base.
 * @returns {string[]} sorted relative paths.
 */
function walk(root, base = root) {
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(absolute, base))
      continue
    }
    if (entry.isFile()) out.push(toPosix(relative(base, absolute)))
  }
  return out.sort()
}

/**
 * Remove a workspace.
 * @param {string} root - workspace root.
 * @returns {void}
 */
export function dropWorkspace(root) {
  rmSync(root, { recursive: true, force: true })
}

/**
 * Read one file from a workspace.
 * @param {string} root - workspace root.
 * @param {string} rel - relative path.
 * @returns {string} the file text.
 */
export function read(root, rel) {
  return readFileSync(join(root, rel), 'utf8')
}

/**
 * Build a minimal Cordis context good enough to mount this plugin.
 * @returns {object} the fake context plus its service and tool registries.
 */
export function makeFakeContext() {
  /** @type {Map<string, unknown>} */
  const services = new Map()
  /** @type {Map<string, unknown>} */
  const tools = new Map()
  const events = []
  const ctx = {
    get: name => services.get(name),
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    effect(callback) {
      return callback()
    },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return { ctx, services, tools, events }
}

/**
 * Invoke one registered tool by name.
 * @param {Map<string, object>} tools - the tool registry.
 * @param {string} name - tool name.
 * @param {object} args - tool arguments.
 * @returns {Promise<{value: object, text: string}>} the canonical value and rendered text.
 */
export async function callTool(tools, name, args) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`unknown tool "${name}"`)
  const value = await definition.execute(args, { signal: undefined })
  const content = definition.output.render(args, value)
  return { value, text: content.map(block => block.text).join('\n') }
}
