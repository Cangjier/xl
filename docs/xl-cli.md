# xl CLI 参考文档

> `xl` 有三个命令：**`xl build`**、**`xl check`**、**`xl targets`**。
> 语法以 [`xl-syntax.md`](./xl-syntax.md)（下称「语法」）为唯一事实来源，本文只描述 CLI 的接口与行为，与其冲突时以语法为准。

> 产物映射见 [`xl-emit-ts.md`](./xl-emit-ts.md)；诊断码见 [`xl-check.md`](./xl-check.md)；完整输入与期望产物见 [`xl-base-case.md`](./xl-base-case.md)。

> 源文件是 `*.xl.md`，UTF-8 无 BOM、LF。

---

## 1. 总览

`xl build` 把 `*.xl.md` 编译成目标语言代码。只有两条通道：

```text
*.xl.md ──► 解析 ──► IR（语言无关） ──┬─► ts        ：xl 内置打印器「直出」.ts 并写盘
                                      └─► 其它语言 ：xl 只给出计划与契约；
                                                     生成由 DSH 会话里的 agent 调用 xl_* 工具完成
```

| 目标 | 通道（内部名） | 生成者 | 是否联网 |
| --- | --- | --- | --- |
| `ts` | `direct` | `xl` 内置打印器，见 [`xl-emit-ts.md`](./xl-emit-ts.md) | 否，完全离线、确定性、字节稳定 |
| 其它语言 | `harness`（人可读输出里写作 `plan`） | 调用 `xl_*` 工具的 DSH agent | 由调用它的会话决定；`xl` 自己**不调用模型、不起子进程** |

* **ts 是唯一有确定性后端的语言**：`ts` 代码块就是目标代码本体，`xl` 只做包装（补 `export`、类型映射、语法糖展开）。
* **其它语言一律是计划通道**：`xl` 给出产物路径、结构契约、语言上下文与上一版产物，实际代码由 agent 写、经 `xl_emit` 落盘（§3.4）。
* 两条通道产出相同的**结构契约**：命名空间、类型名、成员名与签名一一对应。
* 布局（`file` / `type`）与部件表（`parts`）都是**目标的属性**，不是调用的选项：没有任何命令行参数或 `xl.json` 字段能改变某一个目标产出哪些文件（§3.5）。

### 1.1 目标

| 目标 | 别名 | 产物扩展名 | 布局 | 部件 |
| --- | --- | --- | --- | --- |
| `ts` | `typescript` | `.ts` | `file` | `file` |
| `csharp` | `cs`、`c#`、`.net` | `.cs` | `type` | `file` |
| `java` | — | `.java` | `type` | `file` |
| `python` | `py`、`python3` | `.py` | `type` | `file` |
| `go` | `golang` | `.go` | `type` | `file` |
| `rust` | `rs` | `.rs` | `type` | `file` |
| `cpp` | `c++`、`cplusplus`、`cxx` | `.h` + `.cpp` | `type` | `header`（`.h`）+ `source`（`.cpp`） |
| 自定义 | — | 由 `xl.json` 的 `targets.<lang>.ext` / `parts` 声明 | `type` | 由声明决定 |

`xl targets` 打印这张表的机器可读形态（§3.7）。

### 1.2 术语

| 术语 | 含义 |
| --- | --- |
| 源文件 | `*.xl.md`，语法见 [`xl-syntax.md`](./xl-syntax.md) |
| 段落 | 一级标题 `# …`：`dependencies` / `namespace` / `type` / `const` / `method` / `enum` / `interface` / `class` / `statement` |
| 成员 | 二级标题 `## …` 及 enum 的 `- case` 列表项 |
| 语言子标题 | `## <lang>` / `### <lang>` / `#### <lang>`，只作说明，不进默认语言产物 |
| 依赖导入 | `# dependencies` 的 ```` ```xl ```` 块里 `import { … } from "./x.xl.md"` |
| IR | 解析后的语言无关结构（内部表示），build 用它做校验、计划与产物核对 |
| 产物 | 生成的目标语言文件，首三行是 `@generated` 头与指纹（§3.6） |
| 部件（part） | 一个「源 × 目标」单元产出的一份文件；只有 `cpp` 有两个（§3.5） |
| 计划通道 | 非 ts 目标的通道：`xl` 计划 + agent 生成 + `xl_emit` 落盘 |

---

## 2. 安装与调用

`xl` 命令由 **`xl` profile** 提供（bundle patch 里的 `xl-cli` 行只在 profile 名为 `xl` 时启用）。安装见 [`../README.md`](../README.md) §2。

```bash
xl build                              # 编译当前目录下所有 *.xl.md（缺省 -t ts）
xl build pkg/demo.xl.md -t csharp     # 单文件、指定目标
xl build . -t ts -t csharp -t cpp     # 多目标；ts 写盘，其余只给计划
xl check .                            # 只做静态检查
xl targets                            # 列出已知目标
xl --help                             # 帮助（没有额外的 help 命令）
xl --version                          # 版本
```

Node.js ≥ 20，Windows / macOS / Linux。所有路径参数同时接受文件、目录与 glob（§3.2）。所有输出路径一律用 POSIX 分隔符，便于跨平台比对。

---

## 3. `xl build`

### 3.1 用法

```text
xl build [paths...] [options]
```

| 分组 | 选项 | 作用 |
| --- | --- | --- |
| 目标 | `-t, --target <lang>` | 目标语言，可重复（`-t ts -t csharp`）。缺省顺序见下方「缺省目标」 |
| 输出 | `-o, --out <dir>` | 输出根目录（缺省取 `xl.json` 的 `build.out`，再缺省 `dist`）；每个目标语言各自一层子目录（§3.5） |
| 输出 | `--flat` | 丢弃源文件相对目录层级，所有产物写到该语言的目录下 |
| 输出 | `--stdout` | 产物（含 `@generated` 头）写标准输出、不落盘 |
| 生成 | `--naming <mode>` | `idiomatic`（缺省）\| `preserve`：类型文件的命名策略（§3.5） |
| 生成 | `--force` | 忽略复用判定，强制重新生成；并允许覆盖计划路径上的非 xl 产物 |
| 生成 | `--no-cache` | 本次不读也不写增量缓存 `cache.json`，**也不再写历史版本归档**，也不报告手改检测（§3.6） |
| 生成 | `--clean` | 构建前归档并删除本次计划的所有产物，并强制重新生成（`--dry-run` / `--stdout` 下不删除任何东西） |
| 生成 | `--dry-run` | 只打印「源 → 产物」计划，不写盘（照常报告输出冲突与手改提示） |
| 生成 | `--verify` / `--no-verify` | **接受但不生效**：只决定 `xl_emit` 工具的 `verify` 缺省（§3.4） |
| 校验 | `--ignore <codes>` | 忽略指定诊断码，逗号分隔，如 `--ignore W3011,E1107`；产物层的 `E2001` / `E2002` / `E2003` 不可忽略（§3.8） |
| 校验 | `--strict` | warning 视为 error（**只对 `xl check` 生效**，§3.8） |
| 校验 | `--max-warnings <n>` | warning 超过 n 条即失败（**只对 `xl check` 生效**；缺省不限） |
| 输出 | `--format <fmt>` | `pretty`（缺省）\| `compact` \| `json`（§3.7） |
| 全局 | `--cwd <dir>` | 以指定目录为基准解析路径与配置（缺省当前目录） |
| 全局 | `-q, --quiet` | 只输出 error（等价 `XL_LOG=silent` / `XL_LOG=error`） |
| 全局 | `--verbose` | 额外把计划与提示写到 stderr（等价 `XL_LOG=debug`） |
| 全局 | `--json` | NDJSON 事件流（§3.7），不写人类可读输出 |
| 全局 | `--color <when>` | `auto`（缺省，跟随 TTY）\| `always` \| `never`；`NO_COLOR` / `FORCE_COLOR` 同样生效 |
| 全局 | `-h, --help` / `-v, --version` | 帮助 / 版本 |

**接受但无效的选项**：`--harness` / `--harness-profile` / `--timeout` / `--retries` / `--keep-going` / `--concurrency` / `--verify` / `--no-verify`。它们属于「xl 自己 spawn harness」的旧设计；本实现没有子进程通道，因此只是为了让既有命令行不报错而被接受，`--verbose` 下会提示一次。`--concurrency` 不影响结果（ts 打印是同步的），`--verify` / `--no-verify` 只影响 `xl_emit` 工具的缺省（§3.4）。

**只属于 `xl check` 的判定项**：`--strict` 与 `--max-warnings` 在 `xl build` 上被接受但不读取——`xl build` 的退出码只由 error 数决定（§3.8）。

**缺省目标**的解析顺序是 `-t` / `--target` → `xl.json` 的 `build.target` → 服务行的 `defaultTargets`（bundle patch 里是 `['ts']`）→ `ts`。`defaultTargets` 只是部署侧的兜底：只有请求与 `xl.json` 都没给目标时才会被采用。

同一目标只构建一次；`-t` 重复给同一语言时去重（按别名归一后的规范名）。**配置优先级**：CLI 参数 > 环境变量 > `xl.json` > 内置缺省。

### 3.2 输入解析

1. 展开每个 `paths`：文件 → 自身（显式给出的文件不检查 `.xl.md` 后缀，直接当源文件解析）；目录 → 递归 `**/*.xl.md`；glob → 匹配结果（支持 `*`、`**`、`?`、`[abc]`、`{a,b}`）；缺省等价于 `.`。`--` 之后的参数一律当路径。
2. 过滤：排除目录 `node_modules`、`.git`、`dist`、`build`、`.xl`，以及 `.xlignore` 里的模式（该文件在工作目录根部，`#` 起首为注释）；产物文件（首行含 `@generated by xl`）永不作为输入。
3. 去重并按路径字典序排序，保证产物与事件顺序稳定。
4. 每个源文件先解析并校验（语法错误见 [`xl-check.md`](./xl-check.md)）：**有 error 就终止**，退出码 1；warning 只提示。
5. `# dependencies` 里的 ```` ```xl ```` 块解析出跨文件引用，用于校验类型可见性与补齐生成上下文；依赖文件不因为被引用就参与构建，产物仍然只按 `paths` 生成（依赖文件自身的诊断也不出现在输出里）。
6. 结果为空（路径不存在 `E0001`、或没有匹配到 `*.xl.md` `E0002`）→ 用法错误，退出码 2。

### 3.3 `-t ts`：直出

* `ts` 代码块**原样**成为方法体 / 字段初始化表达式，只做最小规范化（统一换行、去尾随空白、去公共缩进；`xl-emit-ts.md` §11）。
* 由声明本身派生出的包装规则（完整列表见 [`xl-emit-ts.md`](./xl-emit-ts.md)，期望产物见 [`xl-base-case.md`](./xl-base-case.md)）：
  * 顶层 `# interface` / `# class` / `# enum` / `# type` / `# const` / `# method` → 加 `export`；`# statement`（语法 §17）不加任何前缀，默认语言块原样成为一个段落；
  * `readonly field id:string` → `public readonly id: string`（`static`、`private` 同理）；
  * `## property label:string` + `### get` / `### private set` → 私有字段 `#label` + `get` / `set` 访问器；
  * `async (url:string)=>string` → `public async load(url: string): Promise<string>`；
  * 体内出现 `yield` → `public *tick(): Generator<number>`；
  * `# dependencies` 的 ```` ```xl ```` 块 `import { level } from "./util.xl.md"` → `import { level } from "./util";`（块里已手工 import 同一模块时不重复生成）。
* 类型映射摘要：

  | 源类型 | ts |
  | --- | --- |
  | `int` / `float` / `double` / `number` | `number` |
  | `bool` / `boolean` | `boolean` |
  | `string` / `any` / `void` / `undefined` / `null` / `never` / `unknown` / `object` | 同名 |
  | `Array<T>` / `T[]` | `T[]`（`Array<Array<int>>` → `number[][]`） |
  | `ReadonlyArray<T>` | `readonly T[]` |
  | `Map<K,V>` / `Set<T>` / `Promise<T>` / `Generator<T>` / `AsyncGenerator<T>` / `Record<…>` / `Partial<…>` / `Readonly<…>` | 同名，实参递归映射 |
  | 其它具名类型 | 原样保留 |
  | 字面量类型（`"printable"` / `2` / `true`） | 原样保留 |
  | 函数类型 `(a:int)=>void` | `(a: number) => void` |
  | 联合 `A \| B` | 原样保留 |

* **ts 构建永不联网**：即使命令行里同时给了 `-t ts -t csharp`，ts 部分也不读取任何 provider / 模型配置。
* 一次 `xl build` 只会把 **ts 产物**写到磁盘，并为它记录增量缓存（§3.6）。

### 3.4 其它语言：计划通道

非 `ts` 目标不生成代码：`xl build -t csharp` 是一条**纯计划命令**，它打印每个「源 × 目标」要产出的文件路径、复用判定，然后提示下一步就退出（不写盘、不调用模型、不启动子进程）：

```console
$ xl build . -t csharp
[csharp] pkg/demo.xl.md -> dist/csharp/pkg/DemoModule.cs, dist/csharp/pkg/Point.cs (planned — missing artifact dist/csharp/pkg/DemoModule.cs) — generate it in a DSH session with the xl_* tools
✔ build done in 0.0s — 0 written, 0 skipped, 1 planned, 0 error(s)
planned outputs belong to a DSH session: call xl_context, then xl_emit.
```

生成由 DSH 会话里的 agent 完成，它用这七个模型工具（`xl_*`）：

| 工具 | 作用 |
| --- | --- |
| `xl_plan` | 列出源与每个「源 × 目标」的计划产物、复用判定（与 `xl build -t <其它语言>` 看到的是同一份计划数据） |
| `xl_context` | 一份「源 × 目标」的完整生成依据：契约（结构摘要 + 输出路径 + 部件 + `layout`）、`promptHash`、该源与依赖的目标语言覆盖段、上一版产物 |
| `xl_cache` | 该「源 × 目标」的缓存状态：是否 reusable、源指纹、`promptHash`、上一版（按部件扩展名给） |
| `xl_verify` | 不写盘地校验候选产物（结构回读） |
| `xl_emit` | 校验并写盘：加产物头与指纹、归档被覆盖的那一版、更新 cache；漏产物 / 多产物 / 结构不符一律拒绝且不写盘 |
| `xl_check` | 与 `xl check` 同一个检查器 |
| `xl_build` | 与 `xl build` 同一个构建器（ts 写盘，其余只给计划） |

**输出契约**（写进 `xl_context`，并由 `xl_emit` 的结构回读强制）：

* `xl_emit` 的 `files` 必须**逐一对应**计划报出的路径：给出计划外的路径报 `E2001`；漏掉计划内的路径、或产物结构与 IR 不一致报 `E4002`，且**一个文件都不写**。
* 产物内容只写目标语言代码：不加 Markdown 围栏，不写对话 / 工具调用标记，不写 `@generated` 头（由 `xl` 统一追加，§3.6）。
* `layout=file` 的单元只有一份产物；`layout=type` 每个类型一份，模块级 `# type` / `# const` / `# method` / `# statement` 合并进 `<源文件基名>Module.<ext>` 一份。
* import / using 集中在文件最前面；同一个文件里不重复声明命名空间。
* 类型名、成员名、参数名、可见性、泛型约束与 `readonly` / `static` / `async` 语义必须与 IR 一致；不得凭空增加公开 API；不得吞掉 `## <lang>` 段里的明确说明。

**结构回读校验**（`xl_verify` / `xl_emit`）是轻量符号扫描，不是解析器，只核对三件事：

| 核对 | 规则 |
| --- | --- |
| 类型集合 | IR 里的每个 `enum` / `interface` / `class` 必须在产物里出现（声明或被提到） |
| 成员名集合 | 声明部件（默认，`scope: declaration`）必须提到每个成员；定义部件（`cpp` 的 `.cpp`，`scope: definition`）只要求提到它实现的那个类型，以及它确实写出来的成员 |
| 参数个数 | 产物里同名成员的参数个数必须与 IR 中的某个声明一致（允许重载） |

模块级 `# method` / `# const` / `# type` 同表核对；`# statement` 不参与（它不声明名字）。

**`promptHash`** 是生成上下文的指纹：`sha256(结构摘要 + 语言覆盖段 + 依赖摘要 + layout + parts + naming)` 的前 16 个十六进制字符，**不含源文件原文**（原文由 `xl:sha256` 表达）。它变了就说明生成依据变了，cache 因此失效。

**工具参数的覆盖范围**：`xl_plan` / `xl_build` / `xl_context` / `xl_verify` / `xl_emit` 都接受 `out` / `naming` / `flat`；`xl_cache` 只接受 `out`。这些值参与**路径计算**，所以 `xl_verify` / `xl_emit` 必须收到与 `xl_plan` / `xl_context` 完全相同的一组值，否则重新算出的路径与计划对不上，提交会被 `E2001` 拒绝。

### 3.5 输出布局

产物一律落在 `<out>/<目标语言>/…`。`out` 的取值顺序是 `-o` / `--out` → `XL_OUT` → `xl.json` 的 `build.out` → `dist`。源文件 `pkg/demo.xl.md`，`xl build . -o dist -t ts -t csharp -t cpp -t python`：

```text
dist/
  ts/pkg/demo.ts                 # ts / layout=file：一个源文件一个产物
  csharp/pkg/DemoModule.cs       # layout=type：模块级 # type / # const / # method / # statement 合并到这里
  csharp/pkg/IPrintable.cs       # layout=type：interface 各成一文件
  csharp/pkg/Point.cs            # 每个类型各成一文件，enum 也是
  cpp/pkg/demo_module.h          # cpp 一个单元两个部件：header …
  cpp/pkg/demo_module.cpp        #   … 与 source（该单元有函数体，所以被计划）
  cpp/pkg/point.h
  python/pkg/demo_module.py      # 语言目录对所有目标都存在，`type` 布局也不例外
```

| 目标 | 通道 | 产物扩展名 | 布局 | 多部件？ |
| --- | --- | --- | --- | --- |
| `ts` | 直出 | `.ts` | `file` | 否 |
| `csharp` | 计划 | `.cs` | `type` | 否 |
| `java` | 计划 | `.java` | `type` | 否 |
| `python` | 计划 | `.py` | `type` | 否 |
| `go` | 计划 | `.go` | `type` | 否 |
| `rust` | 计划 | `.rs` | `type` | 否 |
| `cpp` | 计划 | `.h` + `.cpp` | `type` | 是 |
| 自定义 | 计划 | 由 `xl.json` 声明 | 恒为 `type` | 由 `parts` 决定 |

* **布局恒定**：`ts` 恒为 `file`，其余目标（含自定义目标）恒为 `type`。命令行与工具都没有 layout 参数，`xl.json` 的 `targets.<lang>.layout` 根本没有被读取。
* **部件表决定一个单元产出几份文件**：`cpp` 声明 `header`（`.h`）与 `source`（`.cpp`），后者带 `requires: "bodies"`，只在单元确实有可执行内容时计划——`enum` / `interface` / `# type` 只声明，永远只有 `.h`；`# statement` 一定有；类与模块级 `# method` / `# const` 在有函数体、代码块初始值或该语言的覆盖段代码时才有 `.cpp`。判定只依赖 IR 与目标名，所以同一份源的计划是确定的。
* **模块文件**：`layout=type` 下，`# type` / `# const` / `# method` / `# statement` 都没有目标语言类型名，因此合并进一个 `<源文件基名>Module.<ext>`（基名经 `--naming` 变换）；`enum` / `interface` / `class` 各成一文件。
* **命名策略** `--naming`：
  * `idiomatic`（缺省）：`csharp` / `java` / `go` 用 `PascalCase`，`python` / `rust` / `cpp` 用 `snake_case`（`HTTPClient` → `http_client.h`），其余原样；`csharp` / `java` 的 interface 另加 `I` 前缀（`printable` → `IPrintable.cs`，已经有 `I` + 大写开头时不重复加）。
  * `preserve`：类型名 / 基名原样成为文件名。
* 源文件相对路径在 `<out>/<目标语言>` 下保留（`--flat` 关闭该行为）。保留目录不是装饰：不同源目录里完全可能有同名符号，压平会让两个源文件写同一个路径而静默丢掉一个。
* `out` 可以是相对工作目录的路径，也可以是**绝对路径**：绝对路径会原样出现在计划里（`C:/x/ts/demo.ts`），xl 不再把它拼到工作目录之下。`../out` 这类相对上跳同样可用。
* 同一个产物路径被计划写多次（`--flat` 或撞名）→ 报输出冲突 `E2001`，退出码 1，**绝不静默覆盖**。
* 目标位置已存在**非 xl 产物**文件且无 `--force` → 输出冲突 `E2001`，退出码 1。

### 3.6 产物头、指纹与增量

产物首部固定三行（ts 用 `//`，其它语言按该目标的注释符），之后**空一行**再接正文，与 [`xl-base-case.md`](./xl-base-case.md) 的期望产物一致：

```ts
// @generated by xl from pkg/demo.xl.md
// xl:sha256:9f2c…  xl:target:ts  xl:ver:0.1.0
// DO NOT EDIT — 修改请改 xl.md 并重新生成
```

* 字段之间以**两个空格**分隔。直出通道写 `xl:sha256` / `xl:target` / `xl:ver` 三个字段；计划通道的产物由 `xl_emit` 落盘，另加 `xl:model:<id>`（`xl_emit` 的 `model` 参数）与 `xl:prompt:<hash>`（§3.4）。
* `xl:sha256:<key>` = `sha256(规范化源文件字节)`，规范化只统一换行，因此只改行尾不会让产物失效。
* `xl.json` 的 `build.header: false` 时不写头三行。
* **复用判定**：计划中的每个产物都存在、首行是 xl 头、`xl:target` 是本目标、`xl:sha256` 等于当前源指纹 → 直出通道跳过不写、计划通道报 `reusable`。`--force` 忽略该判定。
* **增量缓存**位于该语言目录下：`<out>/<目标语言>/.xl/cache.json`（每个「源 × 目标」的源指纹、产物路径、产物内容哈希、model、promptHash、写入时间）。`--no-cache` 本次不读也不写这个文件，也不写归档；`build.cacheDir` / `XL_CACHE_DIR` 改变目录名（相对值仍在语言目录之下，绝对值原样使用）。直出通道只记录源指纹 / 产物路径 / 内容哈希；`model` 与 `promptHash` 由 `xl_emit` 记录。
* **历史版本 cache**（`<out>/<目标语言>/.xl/cache/<源相对路径去掉 .xl.md>.<扩展名>.<N>`）：覆盖旧产物前把被覆盖的那一份归档为下一序号，只保留最近 `build.cacheVersions` 版（缺省 5，`false` / `0` 关闭）。归档家族按**源 × 扩展名**组织：`cpp` 的 `.h` 与 `.cpp` 各有自己的历史，因此「上一版」是按部件给出的（`xl_cache` / `xl_context` 的 `previous` 数组）。最新一版是计划通道的「既有实现」，版本一变 `promptHash` 的输入也就变了。
* `--clean` 先归档再删除本次计划的所有产物，然后按 `reuse=false` 重新生成：产物从源重建，历史仍然保留（`--no-cache` 时归档关闭，只删不存）。
* 缓存是**尽力而为**：只计划不落盘（`xl_plan`、`xl build -t <其它语言>`）不会建出 cache 目录；cache 写失败不影响已经写好的产物。
* 产物被手工修改（头在、内容哈希与 cache 记录不符）→ 覆盖前打印警告 `E2003`；`--dry-run` 时同样提示，只是不写盘。`--no-cache` 时无从判断，因此不报告。

### 3.7 控制台输出与 `--json`

```console
$ xl build . -t ts -t csharp
[ts] pkg/demo.xl.md -> dist/ts/pkg/demo.ts (generated)
[csharp] pkg/demo.xl.md -> dist/csharp/pkg/DemoModule.cs, dist/csharp/pkg/Point.cs (planned — missing artifact dist/csharp/pkg/DemoModule.cs) — generate it in a DSH session with the xl_* tools
✔ build done in 0.0s — 1 written, 0 skipped, 1 planned, 0 error(s)
planned outputs belong to a DSH session: call xl_context, then xl_emit.
```

* 每个「源 × 目标」一行：`[<目标>] <源> -> <产物路径…> (<状态><— 原因>)`。状态是 `generated` / `skipped` / `planned` / `failed`。
* 末尾一行汇总：`✔|✖ build done in <秒>s — <写盘数> written, <跳过数> skipped[, <计划数> planned], <错误数> error(s)`。
* 诊断一律写到 **stderr**：`<path>:<line>:<col>: <severity>[<code>]: <message>`，`--format pretty`（缺省）另附源码行、`^` 下划线与 `help:` 行；`--format compact` 每行一条。
* `--quiet` 略去进度行与汇总，只保留 error 级诊断；`--verbose` 额外把计划行与「选项被接受但无效」的提示写到 stderr。两者也可以由 `XL_LOG=silent` / `error` / `debug` 设置（显式 flag 优先）。
* 颜色：`--color always`（或 `FORCE_COLOR`，或 `auto` 下 stdout / stderr 是 TTY）时，诊断的 `severity[code]` 与汇总的 ✔ / ✖ 带 ANSI 颜色；`NO_COLOR` 与 `--color never` 关闭。`--json` 事件流永不带颜色。
* `--dry-run`：只输出计划（`planned`），不写盘、不建 cache。
* `--stdout`：ts 产物（含头）写 stdout、不落盘；计划通道不受影响。
* `--json`：stdout 变成 NDJSON 事件流（每行一个对象，`ev` 是事件名），此时不再输出任何人类可读的进度行或诊断文本。

| 命令 | `ev` | 字段 |
| --- | --- | --- |
| `build` | `build.start` | `targets` `files` |
| `build` | `file.plan` | `src` `target` `channel`（`direct` / `harness`）`out` |
| `build` | `file.done` | `src` `target` `channel` `status`（`generated` / `skipped` / `planned` / `failed`）`out` |
| 两者 | `diag` | `file` `line` `col` `severity` `code` `msg`，可选 `help` `endLine` `endCol` |
| `build` | `build.warn` / `build.error` | `msg` `src` `target` |
| `build` | `build.end` | `ok` `written` `skipped` `planned` `warnings` `errors` `ms` |
| `check` | `check.end` | `ok` `files` `errors` `warnings` |
| `targets` | `target` | `name` `channel`（`direct` / `harness`）`ext`（逗号分隔的扩展名）`layout` `parts` |

> `channel` 字段用的是内部名 `direct` / `harness`；人可读输出把它渲染为 `direct` / `plan`。

`xl targets` 的输出是制表符分隔的四列 `名称 <TAB> 通道 <TAB> 扩展名（逗号分隔） <TAB> 布局`，没有表头：

```console
$ xl targets
ts	direct	.ts	file
csharp	plan	.cs	type
java	plan	.java	type
python	plan	.py	type
go	plan	.go	type
rust	plan	.rs	type
cpp	plan	.h,.cpp	type
```

### 3.8 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功（允许存在 warning）；`xl build` 下有目标只被计划也算成功 |
| 1 | 源文件有 error、输出冲突、写盘失败 |
| 2 | 用法错误（未知命令 / 未知选项 / 无输入 / 路径不存在 `E0001` / 没匹配到输入 `E0002` / 非法 `--target` `E0003` / 未声明扩展名或部件表的自定义目标 `E0004`） |

> `xl` 不返回 3 / 4：计划通道的失败由会话里的 `xl_emit` 以 `E4002` 表达（[`xl-check.md`](./xl-check.md) §5）。
> `--ignore` 只对解析 / 检查层的码生效；产物层的 `E2001` / `E2002` / `E2003` 写进 `--ignore` 也会照常计数，写盘失败或输出冲突一律退出 1。

---

## 4. 配置文件 `xl.json`

查找顺序：`XL_CONFIG` 显式指定 → 从 `--cwd` 逐级向上找 `xl.json` → `xl.config.json` → `package.json` 的 `"xl"` 字段。

```jsonc
{
  "build": {
    "target": ["ts"],             // 缺省目标：字符串或数组
    "out": "dist",                // 输出根目录
    "naming": "idiomatic",        // idiomatic | preserve
    "header": true,               // 是否写 @generated 头
    "cacheVersions": 5,           // 历史版本 cache 保留几版；false / 0 关闭
    "cacheDir": ".xl",            // 每个语言目录下的 cache 目录名
    "concurrency": 4,             // 读入但不生效
    "verify": true,               // 读入但不影响 xl build（只作为 xl_emit 的缺省）
    "specHint": "./docs/xl-syntax.md"   // 读入但不生效
  },
  "check": {
    "ignore": ["W3011"],          // 忽略的规则码；规则码见 xl-check.md
    "strict": false,              // warning 视为 error
    "maxWarnings": null           // warning 数量上限；null 不限
  },
  "targets": {
    "csharp": { "namespace": "Demo.Generated" },       // 读入目标描述符，但当前无人消费
    "kotlin": { "ext": ".kt" },                        // 自定义目标：单部件
    "objcpp": {                                        // 自定义目标：多部件
      "parts": [
        { "role": "header", "ext": ".h" },
        { "role": "source", "ext": ".mm", "requires": "bodies", "scope": "definition" }
      ]
    }
  }
}
```

* 自定义目标必须给 `targets.<lang>.ext`（等价于 `parts: [{ "role": "file", "ext": … }]`）或 `parts`；两者都没有是用法错误 `E0004`，退出码 2。`parts` 里 `role` 是部件名（缺省 `part1`、`part2`…，同一目标内唯一），`ext` 必填（可省前导点），`requires` 只认 `"bodies"`，`scope` 只认 `"declaration"` / `"definition"`。
* `build.target` 是缺省目标（字符串或数组），优先级高于部署侧的 `defaultTargets`。
* `build.naming` 不做取值校验：除 `preserve` 之外的一切写法都按 `idiomatic` 处理（命令行上的 `--naming` 会校验，非法值退出码 2）。
* `build.header` 只有写 `false` 才关掉产物头；关掉后产物正文之前不再有空行。
* `build.cacheVersions` 接受数字、`false` / `0`（关闭归档）；其它值（非数字、负数）退回缺省 5，小数向下取整。
* `targets.<lang>.namespace` 被读入目标描述符，但**本实现没有任何地方消费它**：`# namespace` 到目标语言的映射目前由生成者（agent）自己按提示决定。
* **不生效的字段**：`build.concurrency`、`build.verify`、`build.specHint`、`build.source`、`targets.<lang>.layout`（解析自定义目标时根本不读它）、`targets.<lang>.model`（模型 id 现在由 agent 在 `xl_emit` 的 `model` 参数里给出）；`harness` 段整体不再被读取。
* `check` 段影响 `xl check` 与 `xl build` 的隐式校验：规则码、级别与退出码见 [`xl-check.md`](./xl-check.md)。
* 部署侧的 profile 行配置（`workspaceRoot` / `cacheDir` / `defaultTargets` / `verifyOnEmit`）见 [`../README.md`](../README.md) §5.1；`xl.json` 与 `XL_CACHE_DIR` 的优先级更高。

---

## 5. 环境变量

优先级一律是 **CLI 参数 > 环境变量 > `xl.json` > 内置缺省**，所有入口（`xl build` / `xl check` / `xl targets` 与七个 `xl_*` 工具）都按同一套规则合并。

| 变量 | 作用 |
| --- | --- |
| `XL_TARGET` | 缺省 `-t`（逗号分隔，如 `ts,csharp`） |
| `XL_OUT` | 缺省 `-o` |
| `XL_CONFIG` | 显式指定配置文件路径（不可读或非法时以退出码 1 报错，而不是 2） |
| `XL_CACHE_DIR` | 增量缓存与历史版本 cache 的根，覆盖 `build.cacheDir` |
| `XL_LOG` | `silent` / `error`（等价 `-q`）、`debug`（等价 `--verbose`）、`info`（缺省）；显式的 `-q` / `--verbose` 优先 |
| `NO_COLOR` / `FORCE_COLOR` | 标准化的关色 / 强制着色（`--color` 优先于两者） |

> `XL_TIMEOUT` / `XL_CONCURRENCY` / `XL_HARNESS` 属于早期「xl 自己 spawn harness」的设计，本实现不读取。

---

## 6. 端到端示例

`pkg/demo.xl.md`：

````md
# dependencies
```xl
import { level } from "./util.xl.md"
```

## csharp
```csharp
using System.Text.Json;
```

# namespace demo
demo 包；按目标语言惯例生成命名空间。

# method distance:(a:point, b:point)=>float
两点距离；模块级声明可以排在类型声明之前或之后。
```ts
return Math.hypot(a.x - b.x, a.y - b.y);
```

# class point

## field x:int = 0
横坐标。

## field y:int = 0
纵坐标。

## method move:(dx:int, dy:int)=>void
把点移动 (dx, dy)。
```ts
this.x = this.x + dx;
this.y = this.y + dy;
```
````

```console
$ xl build . -t ts
[ts] pkg/demo.xl.md -> dist/ts/pkg/demo.ts (generated)
✔ build done in 0.0s — 1 written, 0 skipped, 0 error(s)

$ xl build . -t csharp
[csharp] pkg/demo.xl.md -> dist/csharp/pkg/DemoModule.cs, dist/csharp/pkg/Point.cs (planned — missing artifact dist/csharp/pkg/DemoModule.cs) — generate it in a DSH session with the xl_* tools
✔ build done in 0.0s — 0 written, 0 skipped, 1 planned, 0 error(s)
planned outputs belong to a DSH session: call xl_context, then xl_emit.

$ xl build . -t ts --dry-run
[ts] pkg/demo.xl.md -> dist/ts/pkg/demo.ts (planned — dry run)
✔ build done in 0.0s — 0 written, 0 skipped, 0 error(s)
```

计划通道本身就只产计划，所以 `--dry-run` 对它的输出没有影响（原因一栏仍是复用判定的结论）。

计划通道的下一步（在 DSH 会话里）：

```text
xl_plan   → 确认计划产物路径
xl_context → 读契约、语言上下文与上一版
xl_cache  → 取上一版全文（在它之上改而不是重写）
xl_emit   → 一次提交全部部件；xl 校验、加头、归档、更新 cache
```
