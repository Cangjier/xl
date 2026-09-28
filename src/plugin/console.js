/**
 * Console output for the `xl` profile: the human-readable and NDJSON event
 * renderings of check, plan, and build results (xl-cli §3.7, xl-check §2).
 *
 * @module dsh-xl/plugin/console
 */

/**
 * @typedef {object} Console
 * @property {(text: string) => void} out - stdout writer.
 * @property {(text: string) => void} err - stderr writer.
 */

/**
 * Create one invocation's writer.
 *
 * `--json` replaces the human-readable rendering with an NDJSON event stream
 * on stdout, so a machine reader never has to parse prose; every diagnostic
 * still goes to stderr in human form unless `--json` was requested.
 * @param {object} options - output options.
 * @param {Console} options.io - the process streams.
 * @param {boolean} [options.quiet] - suppress everything but errors.
 * @param {boolean} [options.verbose] - add debug lines to stderr.
 * @param {boolean} [options.json] - write an NDJSON event stream to stdout.
 * @param {string | undefined} [options.format] - `pretty`, `compact`, or `json`.
 * @returns {object} the writer.
 */
export function createWriter({ io, quiet = false, verbose = false, json = false, format }) {
  const ndjson = json || format === 'json'
  const compact = format === 'compact'
  const write = text => io.out.write(`${text}\n`)
  const writeErr = text => io.err.write(`${text}\n`)
  return {
    ndjson,
    quiet,
    verbose,

    /**
     * Emit one NDJSON event; a no-op without `--json`.
     * @param {string} ev - event name.
     * @param {object} fields - event fields.
     */
    event(ev, fields) {
      if (!ndjson) return
      write(JSON.stringify({ ev, ...fields }))
    },

    /**
     * Write a normal progress line.
     * @param {string} text - the line.
     */
    info(text) {
      if (quiet || ndjson) return
      write(text)
    },

    /**
     * Write a debug line, shown only with `--verbose`.
     * @param {string} text - the line.
     */
    debug(text) {
      if (!verbose) return
      writeErr(text)
    },

    /**
     * Write a warning.
     * @param {string} text - the line.
     */
    warn(text) {
      if (ndjson) return
      writeErr(text)
    },

    /**
     * Write an error. Always shown, even under `--quiet`.
     * @param {string} text - the line.
     */
    error(text) {
      if (ndjson) return
      writeErr(text)
    },

    /**
     * Render one diagnostic.
     * @param {object} item - the diagnostic.
     * @param {readonly string[]} [sourceLines] - the file's lines, for the pretty caret.
     */
    diagnostic(item, sourceLines) {
      if (ndjson) {
        this.event('diag', {
          file: item.file,
          line: item.line,
          col: item.col,
          severity: item.severity,
          code: item.code,
          msg: item.msg,
          ...item.help === undefined ? {} : { help: item.help },
          ...item.endLine === undefined ? {} : { endLine: item.endLine },
          ...item.endCol === undefined ? {} : { endCol: item.endCol },
        })
        return
      }
      if (quiet && item.severity !== 'error') return
      const head = `${item.file}:${item.line}:${item.col}: ${item.severity}[${item.code}]: ${item.msg}`
      writeErr(head)
      if (compact) return
      const line = sourceLines?.[item.line - 1]
      if (line !== undefined) {
        writeErr(`  ${line}`)
        const width = Math.max(1, (item.endCol ?? item.col + 1) - item.col)
        writeErr(`  ${' '.repeat(Math.max(0, item.col - 1))}${'^'.repeat(width)}`)
      }
      if (item.help !== undefined) writeErr(`  help: ${item.help}`)
    },
  }
}

/**
 * Render the plan of one source × target as a console line.
 * @param {object} plan - the plan.
 * @returns {string} the line.
 */
export function planLine(plan) {
  const channel = plan.channel === 'direct' ? 'direct' : 'plan'
  const outputs = plan.outputs.map(output => output.path).join(', ')
  return `[${plan.target}] ${plan.src} -> ${outputs} (${channel})`
}

/**
 * Render one produced file as a console line.
 * @param {object} file - the file record.
 * @returns {string} the line.
 */
export function fileLine(file) {
  const reason = file.reason === null || file.reason === undefined ? '' : ` — ${file.reason}`
  return `[${file.target}] ${file.src} -> ${file.out.join(', ')} (${file.status}${reason})`
}
