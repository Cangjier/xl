/**
 * The xl diagnostic code table — the single source of truth for a code's
 * severity and its repair hint.
 *
 * The `E`/`W` prefix only names a code's segment (`E0` input, `E1` syntax and
 * structure, `E2` artifact, `E4` harness); a few codes numbered in the `E`
 * segment are warnings (`E1105`, `E1107`, `E2003`). Every severity decision
 * reads this table, never the prefix.
 *
 * @module xl/core/diagnostics
 */

/** @typedef {'error' | 'warning'} Severity */

/**
 * @typedef {object} DiagCode
 * @property {Severity} severity Level that decides exit status and counting.
 * @property {string} help Repair hint printed by the `pretty` format.
 */

/**
 * Code table. Keys are the exact codes reported in diagnostics.
 * @type {Record<string, DiagCode>}
 */
export const DIAG_CODES = {
  // ── E0xxx input and file layer ────────────────────────────────────────────
  E0001: { severity: 'error', help: '检查路径拼写，或省略 paths 让 xl 递归当前目录' },
  E0002: { severity: 'error', help: '指定文件 / 目录 / glob，或确认后缀是 .xl.md' },
  E0003: { severity: 'error', help: '用 xl targets 查看已知目标' },
  E0004: { severity: 'error', help: '在 xl.json 补 "targets": { "<lang>": { "ext": ".kt" } }' },
  E0005: { severity: 'error', help: '另存为 UTF-8（无 BOM）+ LF 换行' },

  // ── E1xxx syntax and structure ───────────────────────────────────────────
  E1001: { severity: 'error', help: '写 # namespace 或直接写一级声明' },
  E1002: { severity: 'error', help: '换成合法关键字，见语法 §2' },
  E1003: { severity: 'error', help: '名字用小写标识符，如 # namespace demo' },
  E1004: { severity: 'error', help: '把 # dependencies 移到文件最前面' },
  E1005: { severity: 'error', help: '按语法 §0 的骨架重排：dependencies → namespace → 模块级声明 → 类型声明' },
  E1006: { severity: 'error', help: '检查相对路径与导出名；依赖文件本身不参与构建，但必须可解析' },

  E1101: { severity: 'error', help: '名字用标识符（与产物 export class point 一致）' },
  E1102: { severity: 'error', help: 'interface 只描述签名；实现放到 # class' },
  E1103: { severity: 'error', help: '每个参数写成 名字 [extends 约束] [= 默认值]' },
  E1104: { severity: 'error', help: '补声明，或修正拼写' },
  E1105: { severity: 'warning', help: '让目标成为 # interface，并补齐 print(): string 之类的成员' },
  E1106: { severity: 'error', help: '改名；同一源文件内符号必须唯一' },
  E1107: { severity: 'warning', help: '改名，避免产物撞名' },
  E1108: { severity: 'error', help: '写成 # type MemberKind = "field" | "method"' },
  E1109: { severity: 'error', help: '删除重复项，或补 - case <name>' },

  E1201: { severity: 'error', help: '换成合法关键字，见语法 §2' },
  E1202: { severity: 'error', help: '只保留该成员种类允许的修饰符（语法 §3、§8、§12–§15）' },
  E1203: { severity: 'error', help: '补合法标识符名字' },
  E1204: { severity: 'error', help: '检查类型写法，见语法 §6、§8、§12' },
  E1205: { severity: 'error', help: '改名' },
  E1206: { severity: 'error', help: '返回类型固定 void，一个类至多一个' },
  E1207: { severity: 'error', help: '改正初始值或类型标注' },
  E1208: { severity: 'error', help: '写成 (a:int, b?:int)，必选参数在前' },
  E1209: { severity: 'error', help: '补 ### get / ### set，或把它改成 ## field' },
  E1210: { severity: 'error', help: '每个访问器至多一次，顺序固定 get → set' },
  E1211: { severity: 'error', help: '只保留一个' },
  E1212: { severity: 'error', help: '写成 - case <name> 或 - case <name> = <原文>（语法 §9）' },

  E1301: { severity: 'error', help: '合并成一个默认语言块，其余改用 ### <lang> 子标题' },
  E1302: { severity: 'error', help: "把默认语言块的围栏改成 'ts'；或放进 ### csharp 之类的语言子标题下" },
  E1303: { severity: 'error', help: '合并同类语言段' },
  E1304: { severity: 'error', help: '删除函数体，或改用 # class' },
  E1305: { severity: 'error', help: '改成 ### get / ### set（仅在 property 下）或 ### <lang>；说明散文直接写在成员标题下' },

  // ── E2xxx artifact layer ─────────────────────────────────────────────────
  E2001: { severity: 'error', help: '去掉 --flat、改名，或加 --force；xl 绝不静默覆盖' },
  E2002: { severity: 'error', help: '检查 --out 权限与磁盘状态' },
  E2003: { severity: 'warning', help: '不要手改产物；改动写回 *.xl.md' },

  // ── W3xxx generation-quality hints ───────────────────────────────────────
  W3010: { severity: 'warning', help: '补一个 ts 默认语言代码块，或加 ### <target> 指示' },
  W3011: { severity: 'warning', help: '补该语言的代码块，或删掉空壳子标题' },
  W3012: { severity: 'warning', help: '补内容，或删除该代码块' },
  W3101: { severity: 'warning', help: '在 # dependencies 的 ## <lang> 段说明该依赖的来源' },
  W3102: { severity: 'warning', help: '补一句用途说明：它会进生成上下文，并成为产出代码注释' },
  W3103: { severity: 'warning', help: '补包用途说明，供非 ts 目标生成使用' },
  W3104: { severity: 'warning', help: '只为确实需要人工指示的目标补 ## <lang> 段；不需要时用 --ignore W3104' },

  // ── E4xxx non-ts generation channel ──────────────────────────────────────
  E4001: { severity: 'error', help: '查看 dsh 会话日志与 profile 组合' },
  E4002: { severity: 'error', help: '收敛生成上下文（补 ## <lang> 指示），或放宽该目标的校验' },
}

/** Codes that are usage errors: they exit 2 and never enter diagnostic counting. */
export const USAGE_CODES = new Set(['E0001', 'E0002', 'E0003', 'E0004'])

/**
 * Severity of a code. An unknown code is treated as an error so a typo cannot
 * silently downgrade a failure.
 * @param {string} code - diagnostic code.
 * @returns {Severity} the code's severity.
 */
export function severityOf(code) {
  return DIAG_CODES[code]?.severity ?? 'error'
}

/**
 * Repair hint of a code.
 * @param {string} code - diagnostic code.
 * @returns {string | undefined} the hint, or `undefined` when the code declares none.
 */
export function helpOf(code) {
  return DIAG_CODES[code]?.help
}

/**
 * Build one diagnostic. `col` defaults to 1 and `endLine`/`endCol` describe the
 * highlighted span; the printable form underlines that span on one source line.
 * @param {object} fields - diagnostic fields.
 * @param {string} fields.code - rule code from {@link DIAG_CODES}.
 * @param {string} fields.file - path relative to the invocation cwd, POSIX separators.
 * @param {number} fields.line - 1-based source line.
 * @param {number} [fields.col] - 1-based source column.
 * @param {string} fields.msg - message text (English, matching the code table).
 * @param {string} [fields.help] - repair hint; defaults to the code table's hint.
 * @param {number} [fields.endLine] - last highlighted line.
 * @param {number} [fields.endCol] - exclusive end column on {@link fields.endLine}.
 * @returns {object} the diagnostic.
 */
export function diag({ code, file, line, col = 1, msg, help, endLine, endCol }) {
  const out = { code, file, line, col, severity: severityOf(code), msg }
  const resolvedHelp = help ?? helpOf(code)
  if (resolvedHelp !== undefined) out.help = resolvedHelp
  if (endLine !== undefined) out.endLine = endLine
  if (endCol !== undefined) out.endCol = endCol
  return out
}

/**
 * Stable diagnostic order: file, then line, then column, then code. A locale
 * comparison would make output depend on the host's collation, so ordering is
 * a plain code-unit comparison.
 * @param {readonly object[]} items - diagnostics to order.
 * @returns {object[]} a new array in stable order.
 */
export function sortDiagnostics(items) {
  return [...items].sort((left, right) => (
    compareText(left.file, right.file)
    || left.line - right.line
    || left.col - right.col
    || compareText(left.code, right.code)
    || compareText(left.msg, right.msg)
  ))
}

/**
 * Drop a diagnostic that repeats one already reported at the same start
 * position with the same code, keeping the one with the larger span.
 * @param {readonly object[]} items - ordered diagnostics.
 * @returns {object[]} deduplicated diagnostics.
 */
export function dedupeDiagnostics(items) {
  /** @type {Map<string, object>} */
  const kept = new Map()
  for (const item of items) {
    const key = `${item.file}\u0000${item.line}\u0000${item.col}\u0000${item.code}\u0000${item.msg}`
    const existing = kept.get(key)
    if (existing === undefined) {
      kept.set(key, item)
      continue
    }
    if (spanOf(item) > spanOf(existing)) kept.set(key, item)
  }
  return [...kept.values()]
}

/**
 * Number of source positions a diagnostic highlights.
 * @param {object} item - diagnostic.
 * @returns {number} highlighted length in positions.
 */
function spanOf(item) {
  const endLine = item.endLine ?? item.line
  const endCol = item.endCol ?? item.col
  return (endLine - item.line) * 1_000_000 + (endCol - item.col)
}

/**
 * Code-unit comparison used by {@link sortDiagnostics}.
 * @param {string} left - first text.
 * @param {string} right - second text.
 * @returns {number} negative, zero, or positive.
 */
function compareText(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Count errors and warnings, skipping ignored codes.
 * @param {readonly object[]} items - diagnostics.
 * @param {ReadonlySet<string>} [ignored] - codes excluded from counting.
 * @returns {{errors: number, warnings: number}} the counts.
 */
export function countBySeverity(items, ignored = new Set()) {
  let errors = 0
  let warnings = 0
  for (const item of items) {
    if (ignored.has(item.code)) continue
    if (item.severity === 'error') errors += 1
    else warnings += 1
  }
  return { errors, warnings }
}
