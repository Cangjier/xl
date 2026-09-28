/**
 * Command-line parsing for the `xl` profile.
 *
 * The parser is hand-written rather than delegated to a command-line library,
 * because this package must stay dependency-free to remain installable into a
 * profile without a build or install step.
 *
 * @module dsh-xl/plugin/args
 */

/** Version reported by `-v` / `--version`. */
export const XL_CLI_VERSION = '0.1.0'

/**
 * @typedef {object} OptionSpec
 * @property {string[]} names - accepted spellings, longest first.
 * @property {string} key - the option key it sets.
 * @property {'string' | 'number' | 'true' | 'false' | 'repeat' | 'list'} kind - how the value is read.
 */

/** Options accepted by `xl build`. */
const BUILD_OPTIONS = [
  { names: ['-t', '--target'], key: 'targets', kind: 'repeat' },
  { names: ['-o', '--out'], key: 'out', kind: 'string' },
  { names: ['--layout'], key: 'layout', kind: 'string' },
  { names: ['--flat'], key: 'flat', kind: 'true' },
  { names: ['--stdout'], key: 'stdout', kind: 'true' },
  { names: ['--naming'], key: 'naming', kind: 'string' },
  { names: ['--force'], key: 'force', kind: 'true' },
  { names: ['--no-cache'], key: 'cache', kind: 'false' },
  { names: ['--clean'], key: 'clean', kind: 'true' },
  { names: ['--concurrency'], key: 'concurrency', kind: 'number' },
  { names: ['--keep-going'], key: 'keepGoing', kind: 'true' },
  { names: ['--dry-run'], key: 'dryRun', kind: 'true' },
  { names: ['--harness'], key: 'harness', kind: 'string' },
  { names: ['--harness-profile'], key: 'harnessProfile', kind: 'string' },
  { names: ['--timeout'], key: 'timeout', kind: 'number' },
  { names: ['--retries'], key: 'retries', kind: 'number' },
  { names: ['--verify'], key: 'verify', kind: 'true' },
  { names: ['--no-verify'], key: 'verify', kind: 'false' },
  { names: ['--ignore'], key: 'ignore', kind: 'list' },
  { names: ['--strict'], key: 'strict', kind: 'true' },
  { names: ['--max-warnings'], key: 'maxWarnings', kind: 'number' },
  { names: ['--format'], key: 'format', kind: 'string' },
]

/** Options accepted by `xl check`. */
const CHECK_OPTIONS = [
  { names: ['-t', '--target'], key: 'targets', kind: 'repeat' },
  { names: ['--strict'], key: 'strict', kind: 'true' },
  { names: ['--max-warnings'], key: 'maxWarnings', kind: 'number' },
  { names: ['--ignore'], key: 'ignore', kind: 'list' },
  { names: ['--format'], key: 'format', kind: 'string' },
  { names: ['--json'], key: 'json', kind: 'true' },
]

/** Options accepted by `xl targets`. */
const TARGETS_OPTIONS = []

/** Options every command accepts. */
const GLOBAL_OPTIONS = [
  { names: ['--cwd'], key: 'cwd', kind: 'string' },
  { names: ['-q', '--quiet'], key: 'quiet', kind: 'true' },
  { names: ['--verbose'], key: 'verbose', kind: 'true' },
  { names: ['--json'], key: 'json', kind: 'true' },
  { names: ['--color'], key: 'color', kind: 'string' },
  { names: ['-h', '--help'], key: 'help', kind: 'true' },
  { names: ['-v', '--version'], key: 'version', kind: 'true' },
]

/** Commands the `xl` profile accepts. */
export const COMMANDS = new Set(['build', 'check', 'targets'])

/**
 * The option table of one command.
 * @param {string} command - command name.
 * @returns {OptionSpec[]} the accepted options.
 */
export function optionTable(command) {
  const specific = command === 'check' ? CHECK_OPTIONS : command === 'targets' ? TARGETS_OPTIONS : BUILD_OPTIONS
  return [...GLOBAL_OPTIONS, ...specific]
}

/**
 * Parse an `xl` invocation.
 * @param {readonly string[]} argv - the arguments after the launcher's own flags.
 * @returns {{command: string | null, paths: string[], options: object, errors: string[]}} the parse result.
 */
export function parseArgs(argv) {
  const errors = []
  const paths = []
  const options = {}
  const args = [...argv]
  let command = null

  if (args.length > 0 && !args[0].startsWith('-')) {
    command = args.shift()
    if (!COMMANDS.has(command)) {
      errors.push(`unknown command "${command}"`)
      return { command, paths, options, errors }
    }
  }

  const table = optionTable(command ?? 'build')
  let positionalOnly = false
  while (args.length > 0) {
    const token = args.shift()
    if (positionalOnly) {
      paths.push(token)
      continue
    }
    if (token === '--') {
      positionalOnly = true
      continue
    }
    if (token === '-' || !token.startsWith('-')) {
      paths.push(token)
      continue
    }
    const separator = token.indexOf('=')
    const name = separator < 0 ? token : token.slice(0, separator)
    const inline = separator < 0 ? undefined : token.slice(separator + 1)
    const spec = table.find(candidate => candidate.names.includes(name))
    if (spec === undefined) {
      errors.push(`unknown option "${name}"`)
      continue
    }
    if (spec.kind === 'true' || spec.kind === 'false') {
      if (inline !== undefined) {
        errors.push(`option "${name}" takes no value`)
        continue
      }
      options[spec.key] = spec.kind === 'true'
      continue
    }
    const value = inline ?? args.shift()
    if (value === undefined) {
      errors.push(`option "${name}" requires a value`)
      continue
    }
    applyValue(options, spec, name, value, errors)
  }

  return { command, paths, options, errors }
}

/**
 * Store one option value, validating its type.
 * @param {object} options - the accumulator.
 * @param {OptionSpec} spec - the option's specification.
 * @param {string} name - the spelling the caller used.
 * @param {string} value - the raw value.
 * @param {string[]} errors - the error accumulator.
 */
function applyValue(options, spec, name, value, errors) {
  switch (spec.kind) {
    case 'repeat': {
      const list = options[spec.key] ?? []
      list.push(value)
      options[spec.key] = list
      return
    }
    case 'list': {
      const list = options[spec.key] ?? []
      for (const part of value.split(',')) {
        const piece = part.trim()
        if (piece !== '') list.push(piece)
      }
      options[spec.key] = list
      return
    }
    case 'number': {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) {
        errors.push(`option "${name}" requires a number, got "${value}"`)
        return
      }
      options[spec.key] = parsed
      return
    }
    default:
      options[spec.key] = value
  }
}

/**
 * Validate the options that have a closed value set.
 * @param {object} options - parsed options.
 * @returns {string[]} the problems found.
 */
export function validateOptions(options) {
  const errors = []
  if (options.layout !== undefined && options.layout !== 'file' && options.layout !== 'type') {
    errors.push(`--layout must be "file" or "type", got "${options.layout}"`)
  }
  if (options.naming !== undefined && options.naming !== 'idiomatic' && options.naming !== 'preserve') {
    errors.push(`--naming must be "idiomatic" or "preserve", got "${options.naming}"`)
  }
  if (options.format !== undefined && !['pretty', 'compact', 'json'].includes(options.format)) {
    errors.push(`--format must be "pretty", "compact", or "json", got "${options.format}"`)
  }
  if (options.color !== undefined && !['auto', 'always', 'never'].includes(options.color)) {
    errors.push(`--color must be "auto", "always", or "never", got "${options.color}"`)
  }
  return errors
}

/** Help text for `xl --help` and `xl build --help`. */
export const HELP_TEXT = `xl ${XL_CLI_VERSION} — xl-md (*.xl.md) compiler

用法:
  xl build [paths...] [options]    把 *.xl.md 编译成目标语言产物
  xl check [paths...] [options]    只做语法 / 结构 / 引用检查，不写盘
  xl targets [options]             列出已知目标
  xl --help | -h                   帮助
  xl --version | -v                版本

通道:
  ts              直出。xl 内置打印器离线生成，字节稳定。
  其它语言        计划通道。xl 只给出产物路径、结构契约、语言上下文与 cache；
                  生成由 DSH 会话里的 agent 调用 xl_* 工具完成，xl 不调用模型。

build 选项:
  -t, --target <lang>       目标语言，可重复（-t ts -t csharp）；缺省取 xl.json 的 build.target，再缺省 ts
  -o, --out <dir>           输出根目录（缺省：源文件同级目录，或 xl.json 的 build.out）
  --layout <mode>           file | type（缺省按目标）
  --flat                    丢弃源文件相对目录层级
  --stdout                  产物正文写标准输出、不落盘
  --naming <mode>           idiomatic（缺省）| preserve
  --force                   忽略指纹与缓存，强制重新生成
  --no-cache                本次不读写增量缓存
  --clean                   构建前删除本次会覆盖的旧产物
  --concurrency <n>         并发任务数（缺省 min(4, CPU)）
  --keep-going              单个文件失败后继续构建其余文件
  --dry-run                 只打印计划，不写盘
  --ignore <codes>          忽略指定诊断码，逗号分隔
  --strict                  warning 视为 error
  --max-warnings <n>        warning 数量上限
  --format <fmt>            pretty（缺省）| compact | json
  --cwd <dir>               以指定目录为基准解析路径与配置
  -q, --quiet               只输出错误
  --verbose                 输出调试信息
  --json                    NDJSON 事件流
  --color <when>            auto（缺省）| always | never

check 选项:
  -t, --target <lang>       决定生成质量提示针对的目标语言
  --strict / --max-warnings <n> / --ignore <codes> / --format <fmt> / --json   同上
  --cwd <dir> / -q / --verbose / --color <when>                               同上

环境变量:
  XL_TARGET XL_OUT XL_CONFIG XL_CACHE_DIR XL_LOG NO_COLOR FORCE_COLOR
  优先级：CLI 参数 > 环境变量 > xl.json > 内置缺省

退出码:
  0 成功（允许 warning）    1 源文件有 error / 输出冲突 / 写盘失败
  2 用法错误                3 计划通道失败（本插件不返回）
`

/** Help text shown when the invocation names no command. */
export const USAGE_TEXT = 'usage: xl <build|check|targets> [paths...] [options]\nrun "xl --help" for details'
