/**
 * The model-facing `xl_*` tools.
 *
 * They are registered with raw JSON Schema (no `defineTool` import) so this
 * package needs no dependency on the harness at runtime: the plugin is a
 * plain ESM module that any profile can install.
 *
 * The tool set is deliberately small. `xl_plan` and `xl_context` are how an
 * agent learns what to produce; `xl_emit` is how it commits a product and gets
 * the header, fingerprint, archive, and cache record for free; `xl_cache`,
 * `xl_verify`, `xl_check`, and `xl_build` are the remaining standardized
 * operations, exposed one per operation rather than one per option.
 *
 * @module xl/plugin/tools
 */

/** Name of every tool this plugin registers. */
export const TOOL_NAMES = [
  'xl_plan',
  'xl_context',
  'xl_cache',
  'xl_verify',
  'xl_emit',
  'xl_check',
  'xl_build',
]

/**
 * Register every `xl_*` tool on a context.
 * @param {object} ctx - the Cordis context carrying `tools`.
 * @param {object} service - the `xl` service from `createXlService`.
 * @returns {void}
 */
export function registerTools(ctx, service) {
  for (const definition of toolDefinitions(service)) {
    ctx.tools.register(definition)
  }
}

/**
 * Build every tool definition.
 * @param {object} service - the `xl` service.
 * @returns {object[]} raw tool definitions.
 */
function toolDefinitions(service) {
  return [
    planTool(service),
    contextTool(service),
    cacheTool(service),
    verifyTool(service),
    emitTool(service),
    checkTool(service),
    buildTool(service),
  ]
}

/** JSON Schema for an optional working-directory property. */
const CWD_PROPERTY = {
  type: 'string',
  description: 'Working directory the paths resolve against. Defaults to the configured workspace root.',
}

/** JSON Schema for the required `file` property of the per-file tools. */
const FILE_PROPERTY = {
  type: 'string',
  description: 'Source path relative to the working directory, for example "pkg/demo.xl.md".',
}

/** JSON Schema for the optional output root shared by the planning tools. */
const OUT_PROPERTY = {
  type: 'string',
  description: 'Output root directory. Defaults to xl.json build.out, then "dist". Every target language gets its own subdirectory, so ts lands in <out>/ts/ and csharp in <out>/csharp/.',
}

/** Output declaration shared by every tool: a JSON object rendered as text. */
const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2) }]
  },
}

/**
 * The `xl_plan` tool.
 * @param {object} service - the `xl` service.
 * @returns {object} the tool definition.
 */
function planTool(service) {
  return {
    name: 'xl_plan',
    description: [
      'Plan the xl build: which files each *.xl.md produces for each target language, whether the cache already',
      'satisfies them, and which generation channel owns them.',
      'The ts target is produced directly by xl_build. Every other target is produced by you: call xl_plan to get',
      'the output paths, then xl_context for the contract, then xl_emit to write the files.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files, directories, or globs. Defaults to the whole working directory.',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Target languages, for example ["csharp"]. Defaults to xl.json build.target, then ts.',
        },
        out: OUT_PROPERTY,
        naming: { type: 'string', enum: ['idiomatic', 'preserve'], description: 'Target-language naming policy for type-layout file names.' },
        flat: { type: 'boolean', description: 'Discard the source directory hierarchy in output paths.' },
        force: { type: 'boolean', description: 'Report every planned output as not reusable.' },
        cwd: CWD_PROPERTY,
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const result = service.plan(args)
      return {
        text: renderPlan(result),
        exitCode: result.exitCode,
        files: result.plans.length,
        planned: result.plans.reduce((total, plan) => total + plan.outputs.length, 0),
      }
    },
  }
}

/**
 * The `xl_context` tool.
 * @param {object} service - the `xl` service.
 * @returns {object} the tool definition.
 */
function contextTool(service) {
  return {
    name: 'xl_context',
    description: [
      'Return the standardized generation context for one *.xl.md and one target language: the exact output paths',
      'to write, the structural contract the product must match, the target-language sections resolved out of the',
      'source and its dependencies, and a pointer to the cached previous version.',
      'Read the *.xl.md sources and requirement documents yourself; this tool supplies what reading them cannot: the',
      'binding contract and the layout.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        file: FILE_PROPERTY,
        target: { type: 'string', description: 'Target language, for example "csharp".' },
        out: OUT_PROPERTY,
        naming: { type: 'string', enum: ['idiomatic', 'preserve'], description: 'Naming policy override.' },
        flat: { type: 'boolean', description: 'Discard the source directory hierarchy.' },
        cwd: CWD_PROPERTY,
      },
      required: ['file', 'target'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const opened = service.context({ ...args, source: args.file })
      return {
        text: renderContext(opened),
        source: opened.context.source,
        target: opened.context.target,
        summary: opened.context.summary,
        language: opened.context.language,
        outputs: opened.context.outputs,
        previous: opened.context.previous === null
          ? null
          : { version: opened.context.previous.version, path: opened.context.previous.path },
        promptHash: opened.context.promptHash,
      }
    },
  }
}

/**
 * The `xl_cache` tool.
 * @param {object} service - the `xl` service.
 * @returns {object} the tool definition.
 */
function cacheTool(service) {
  return {
    name: 'xl_cache',
    description: [
      'Return the cached state for one *.xl.md and target: whether the products on disk already match the source',
      'fingerprint, and the most recent archived version to extend rather than rewrite.',
      'This is the incremental channel. Check it before generating; pass the previous version to the generator when',
      'one exists so an update stays a edit instead of a rewrite.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        file: FILE_PROPERTY,
        target: { type: 'string', description: 'Target language.' },
        out: OUT_PROPERTY,
        cwd: CWD_PROPERTY,
      },
      required: ['file', 'target'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const record = service.cache({ ...args, source: args.file })
      return {
        text: renderCache(record),
        reusable: record.reusable,
        reason: record.reason,
        fingerprint: record.fingerprint,
        promptHash: record.promptHash,
        outputs: record.outputs,
        previous: record.previous === null
          ? null
          : { version: record.previous.version, path: record.previous.path },
      }
    },
  }
}

/**
 * The `xl_verify` tool.
 * @param {object} service - the `xl` service.
 * @returns {object} the tool definition.
 */
function verifyTool(service) {
  return {
    name: 'xl_verify',
    description: [
      'Check proposed products against the structural contract without writing anything: the type set, the member',
      'names, and parameter counts must match the *.xl.md. Call it before xl_emit when you want the verdict',
      'separately; xl_emit verifies as part of writing.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        file: FILE_PROPERTY,
        target: { type: 'string', description: 'Target language.' },
        files: FILES_PROPERTY,
        cwd: CWD_PROPERTY,
      },
      required: ['file', 'target', 'files'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const result = service.verify({ ...args, source: args.file })
      return { text: renderVerify(result), ok: result.ok, issues: result.issues, planned: result.planned }
    },
  }
}

/**
 * The `xl_emit` tool.
 * @param {object} service - the `xl` service.
 * @returns {object} the tool definition.
 */
function emitTool(service) {
  return {
    name: 'xl_emit',
    description: [
      'Write generated products: verify each file against the structural contract, refuse it when it does not match,',
      'and otherwise write it to its planned path with the xl artifact header, source fingerprint, and prompt hash,',
      'archive the version it replaced, and update the incremental cache.',
      'Supply one entry per planned output with the exact path xl_plan or xl_context returned. Supply the code only;',
      'xl adds the header.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        file: FILE_PROPERTY,
        target: { type: 'string', description: 'Target language.' },
        files: FILES_PROPERTY,
        model: { type: 'string', description: 'Model id stamped into the artifact header as xl:model.' },
        force: { type: 'boolean', description: 'Overwrite an existing non-xl file at a planned path.' },
        verify: { type: 'boolean', description: 'Verify before writing. Defaults to true.' },
        out: OUT_PROPERTY,
        cwd: CWD_PROPERTY,
      },
      required: ['file', 'target', 'files'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const result = service.emit({ ...args, source: args.file })
      return {
        text: renderEmit(result),
        ok: result.ok,
        written: result.written,
        skipped: result.skipped,
        planned: result.planned,
        fingerprint: result.fingerprint,
        promptHash: result.promptHash,
        diagnostics: result.diagnostics.map(item => ({
          severity: item.severity,
          code: item.code,
          msg: item.msg,
        })),
      }
    },
  }
}

/**
 * The `xl_check` tool.
 * @param {object} service - the `xl` service.
 * @returns {object} the tool definition.
 */
function checkTool(service) {
  return {
    name: 'xl_check',
    description: [
      'Run the xl static checks over *.xl.md sources and report diagnostics with their rule codes.',
      'Use it before generating so a syntax or structure error is found by the checker instead of by a mismatch',
      'during xl_emit.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Files, directories, or globs.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Targets the generation-quality hints are reported for.' },
        ignore: { type: 'array', items: { type: 'string' }, description: 'Rule codes to ignore, for example ["W3102"].' },
        strict: { type: 'boolean', description: 'Treat warnings as failures.' },
        maxWarnings: { type: 'number', description: 'Fail when more than this many warnings are reported.' },
        cwd: CWD_PROPERTY,
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const result = service.check(args)
      return {
        text: renderCheck(result),
        ok: result.ok,
        files: result.files,
        errors: result.errors,
        warnings: result.warnings,
        exitCode: result.exitCode,
      }
    },
  }
}

/**
 * The `xl_build` tool.
 * @param {object} service - the `xl` service.
 * @returns {object} the tool definition.
 */
function buildTool(service) {
  return {
    name: 'xl_build',
    description: [
      'Run the xl build. The ts target is produced here, deterministically and offline. Every other target is',
      'planned only: this tool never calls a model, because generation belongs to you. Run it after xl_emit so the',
      'report reflects the files you wrote.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Files, directories, or globs.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Target languages.' },
        out: OUT_PROPERTY,
        naming: { type: 'string', enum: ['idiomatic', 'preserve'], description: 'Naming policy override.' },
        flat: { type: 'boolean', description: 'Discard the source directory hierarchy.' },
        force: { type: 'boolean', description: 'Regenerate even when the fingerprint already matches.' },
        dryRun: { type: 'boolean', description: 'Report the plan without writing anything.' },
        cwd: CWD_PROPERTY,
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const result = service.build(args)
      return {
        text: renderBuild(result),
        ok: result.ok,
        exitCode: result.exitCode,
        written: result.written,
        skipped: result.skipped,
        planned: result.planned,
        errors: result.errors,
        warnings: result.warnings,
        files: result.files,
      }
    },
  }
}

/** JSON Schema for the `files` property, shared by `xl_verify` and `xl_emit`. */
const FILES_PROPERTY = {
  type: 'array',
  description: 'One entry per planned output: the exact path and the generated code.',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Planned output path, exactly as xl_plan or xl_context reported it.' },
      content: { type: 'string', description: 'Generated code for that file, without the xl header.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
}

/**
 * Render a plan result for the model.
 * @param {object} result - the plan result.
 * @returns {string} the rendered text.
 */
export function renderPlan(result) {
  const lines = [`xl plan — ${result.cwd}`, '']
  if (result.plans.length === 0) lines.push('(no plan; run xl_check for diagnostics)')
  for (const plan of result.plans) {
    lines.push(`## ${plan.src} → ${plan.target} (${plan.channel === 'direct' ? 'direct, produced by xl_build' : 'plan, produced by you'})`)
    lines.push(`layout: ${plan.layout}${plan.previous === undefined ? '' : ` · previous version: ${plan.previous.path}`}`)
    lines.push(`reusable: ${plan.reuse.reusable ? 'yes' : `no (${plan.reuse.reason})`}`)
    for (const output of plan.outputs) {
      lines.push(`- ${output.path} — ${output.kind === 'module' ? `module-level: ${output.names.join(', ')}` : output.names.join(', ')}`)
    }
    lines.push('')
  }
  if (result.errors > 0 || result.warnings > 0) {
    lines.push(`diagnostics: ${result.errors} error(s), ${result.warnings} warning(s)`)
  }
  return lines.join('\n').trimEnd()
}

/**
 * Render a generation context for the model.
 * @param {object} opened - the `contextFor` result.
 * @returns {string} the rendered text.
 */
export function renderContext(opened) {
  const { context } = opened
  const lines = []
  lines.push(`# xl context — ${context.source} → ${context.target}`)
  lines.push('')
  lines.push(`layout: ${context.layout} · naming: ${opened.resolved.options.naming} · channel: plan (you generate the code)`)
  lines.push(`source fingerprint: ${opened.plan?.fingerprint ?? '(unavailable)'}`)
  lines.push(`context hash: ${context.promptHash}`)
  lines.push('')
  lines.push('## Write exactly these files')
  for (const output of context.outputs) {
    lines.push(`- \`${output.path}\` — ${output.kind === 'module' ? `module-level declarations: ${output.names.join(', ')}` : output.names.join(', ')}`)
  }
  lines.push('')
  lines.push('## Structural contract (the product must match it)')
  lines.push('```json')
  lines.push(JSON.stringify(context.summary, null, 2))
  lines.push('```')
  if (context.language.namespace !== null) {
    lines.push('')
    lines.push(`## Namespace \`${context.language.namespace.name}\``)
    if (context.language.namespace.note !== '') lines.push(context.language.namespace.note)
    if (context.language.namespace.target !== undefined && context.language.namespace.target !== null) {
      lines.push(context.language.namespace.target)
    }
  }
  const sections = context.language.sections
  if (sections.length > 0) {
    lines.push('')
    lines.push(`## ${context.target} sections from the source`)
    for (const section of sections) {
      lines.push(`### ${section.owner}`)
      if (section.prose !== '') lines.push(section.prose)
      if (section.code !== '') {
        lines.push(`\`\`\`${context.target}`)
        lines.push(section.code)
        lines.push('```')
      }
    }
  }
  if (context.dependencies.length > 0) {
    lines.push('')
    lines.push('## Dependencies (read these files yourself)')
    for (const dependency of context.dependencies) {
      lines.push(`- \`${dependency.path}\``)
    }
  }
  lines.push('')
  lines.push('## Cached previous version')
  if (context.previous === null) {
    lines.push('none — this is the first generation for this source and target.')
  } else {
    lines.push(`\`${context.previous.path}\` (version ${context.previous.version}). Call xl_cache to read it, then extend it instead of rewriting.`)
  }
  lines.push('')
  lines.push('## Next')
  lines.push('1. Read the source `*.xl.md` and any requirement documents you were given.')
  lines.push('2. Call `xl_cache` when a previous version exists.')
  lines.push(`3. Call \`xl_emit\` with file = "${context.source}", target = "${context.target}", and one entry per path above.`)
  return lines.join('\n')
}

/**
 * Render a cache record for the model.
 * @param {object} record - the cache record.
 * @returns {string} the rendered text.
 */
export function renderCache(record) {
  const lines = [`# xl cache — ${record.source} → ${record.target}`, '']
  lines.push(`reusable: ${record.reusable ? 'yes — the products on disk already match the source fingerprint' : `no — ${record.reason ?? 'unknown reason'}`}`)
  lines.push(`source fingerprint: ${record.fingerprint ?? '(unavailable)'}`)
  lines.push(`context hash: ${record.promptHash}`)
  lines.push('')
  lines.push('## Planned outputs')
  for (const output of record.outputs) lines.push(`- \`${output.path}\``)
  lines.push('')
  if (record.previous === null) {
    lines.push('## Previous version')
    lines.push('none — nothing has been archived for this source and target yet.')
  } else {
    lines.push(`## Previous version (${record.previous.path}, version ${record.previous.version})`)
    lines.push('```')
    lines.push(record.previous.text.replace(/\n$/, ''))
    lines.push('```')
  }
  return lines.join('\n')
}

/**
 * Render a verification verdict for the model.
 * @param {object} result - the verification result.
 * @returns {string} the rendered text.
 */
export function renderVerify(result) {
  if (result.ok) return `xl verify: ok — every proposed file matches the structural contract.\nplanned: ${result.planned.join(', ')}`
  const lines = ['xl verify: mismatch']
  for (const entry of result.issues) {
    lines.push(`- ${entry.path}`)
    for (const issue of entry.issues) lines.push(`  - ${issue}`)
  }
  for (const path of result.unexpected) {
    lines.push(`- "${path}" is not a planned output`)
  }
  lines.push(`planned: ${result.planned.join(', ')}`)
  return lines.join('\n')
}

/**
 * Render an emit result for the model.
 * @param {object} result - the emit result.
 * @returns {string} the rendered text.
 */
export function renderEmit(result) {
  const lines = [result.ok ? 'xl emit: ok' : 'xl emit: failed']
  if (result.written.length > 0) lines.push(`written: ${result.written.join(', ')}`)
  if (result.skipped.length > 0) lines.push(`skipped: ${result.skipped.join(', ')}`)
  if (result.fingerprint !== undefined) lines.push(`fingerprint: ${result.fingerprint}`)
  if (result.promptHash !== undefined) lines.push(`context hash: ${result.promptHash}`)
  for (const item of result.diagnostics) {
    lines.push(`${item.severity}[${item.code}] ${item.msg}`)
  }
  if (!result.ok) {
    lines.push('Fix the reported mismatches and call xl_emit again, or call xl_verify first.')
  }
  return lines.join('\n')
}

/**
 * Render a check result for the model.
 * @param {object} result - the check result.
 * @returns {string} the rendered text.
 */
export function renderCheck(result) {
  const lines = [`xl check — ${result.files} file(s), ${result.errors} error(s), ${result.warnings} warning(s)`]
  for (const item of result.diagnostics) {
    lines.push(`${item.file}:${item.line}:${item.col}: ${item.severity}[${item.code}]: ${item.msg}`)
    if (item.help !== undefined) lines.push(`  help: ${item.help}`)
  }
  return lines.join('\n')
}

/**
 * Render a build result for the model.
 * @param {object} result - the build result.
 * @returns {string} the rendered text.
 */
export function renderBuild(result) {
  const lines = [
    `xl build — ${result.written} written, ${result.skipped} skipped, ${result.planned ?? 0} planned, ${result.errors} error(s), ${result.warnings} warning(s)`,
  ]
  for (const file of result.files) {
    lines.push(`${file.status}: ${file.src} → ${file.target} [${file.channel}] ${file.out.join(', ')}${file.reason === null ? '' : ` (${file.reason})`}`)
  }
  for (const item of result.diagnostics) {
    lines.push(`${item.file}:${item.line}: ${item.severity}[${item.code}]: ${item.msg}`)
  }
  if (result.planned > 0) {
    lines.push('')
    lines.push('The planned outputs above are yours to generate: call xl_context for each source and target, then xl_emit.')
  }
  return lines.join('\n')
}
