# C++ 生成指南（推荐）

> **这不是直出通道的规范，而是 DSH 会话在编译 `*.xl.md` 到 C++ 时的推荐方案。**
> `cpp` 走**计划通道**（[`xl-cli.md`](./xl-cli.md) §3.4）：`xl` 只给出产物路径、结构契约与语言上下文，代码由会话里的 agent 写、经 `xl_emit` 落盘。所以本文里的每一条都是**默认约定**，不是 `xl` 会校验的字节契约：`xl_emit` 只强制「类型集合 / 成员名集合 / 参数个数」这三项结构回读（`xl-cli.md` §3.4），其余取舍（容器选型、命名风格、要不要折叠成员）由生成者判断。
> 什么时候可以偏离本文：`*.xl.md` 里的 `## cpp` / `### cpp` / `#### cpp` 覆盖段、目标仓库自己的编码规范、或既有实现（`xl_cache` 给出的上一版）。**覆盖段与既有实现优先于本文**（§12）。
> 语法以 [`xl-syntax.md`](./xl-syntax.md)（下称「语法」）为唯一事实来源；ts 直出的同类映射见 [`xl-emit-ts.md`](./xl-emit-ts.md)（本文多处与它同构，便于对照）；诊断码见 [`xl-check.md`](./xl-check.md)。

> 与 `ts` 通道的根本差别：`ts` 的代码块**就是**目标代码本体，打印器只做包装；C++ 的 `ts` 代码块**只是行为说明**，必须被改写成 C++。本文就是这份改写规则的默认答案。

---

## 1. 生成契约

| 项 | 内容 |
| --- | --- |
| 输入 | 一个 `*.xl.md` 的 IR + 原文 + `xl_context` 报出的契约（输出路径、部件、layout、`## <lang>` 段、上一版产物） |
| 输出 | 一个单元的 `.h`（`part: header`）+ 可选 `.cpp`（`part: source`），路径**逐字**取 `xl_context`，不要自己算 |
| 布局 | `layout = type`：`enum` / `interface` / `class` 各成一文件；模块级 `# type` / `# const` / `# method` / `# statement` 合并进 `<源文件基名>_module.{h,cpp}` |
| 命名 | 文件名按 `--naming` 变换，`idiomatic` 下 cpp 用 `snake_case`（`HTTPClient` → `http_client.h`）；**输出路径以 `xl_context` 为准，不要自己拼** |
| 部件 | `.cpp` 带 `requires: "bodies"`，只在单元确实有可执行内容时才被计划（空模板类只有 `.h`，不要交一个空的 `.cpp`） |
| 代码块 | `ts` 块是行为说明；`### cpp` / `#### cpp` / `## cpp` 块是**可直接采用的实现**（§12） |
| 手工添加 | 不许发明 IR 里没有的公开 API；内部辅助（`namespace {}` 里的函数、私有 `static` 成员）必须私有、且只服务于 IR 里已有的成员 |
| 确定性 | 同一 IR + 同一上下文应得到同一份代码：不写时间戳、随机名、机器相关路径；换行 LF；文件末尾恰好一个换行 |
| 编码 | UTF-8 无 BOM；产物头与指纹由 `xl_emit` 统一追加（[`../README.md`](../README.md) §3.2），**生成者不要自己写 `@generated` 头** |
| 构建文件 | **也由生成者负责**：`<out>/cpp/CMakeLists.txt` 是常驻文件，`xl` **不**计划它、**不**校验它、**不**覆盖它；构建树必须落在 `<out>/cpp/build/` 之内（§11） |

---

## 2. 文件骨架

### 2.1 `.h`（声明部件，`scope: declaration`）

```cpp
#ifndef DEMO_POINT_H
#define DEMO_POINT_H

// 标准库在前，本项目头文件在后，各自按字典序
#include <cstdint>
#include <string>

// 依赖导入：路径相对 <out>/cpp/（这里是 dist/cpp/pkg/util.h）
#include "pkg/util.h"

namespace demo {

class point {
 public:
  point() = default;
  point(int32_t x, int32_t y);

  int32_t x() const noexcept;
  void set_x(int32_t value) noexcept;

  // 只在 .cpp 里定义的成员：读方法在 .h 内联、体大的成员留给 .cpp
  void move(int32_t dx, int32_t dy) noexcept;

 private:
  int32_t x_ = 0;
  int32_t y_ = 0;
};

}  // namespace demo

#endif  // DEMO_POINT_H
```

### 2.2 `.cpp`（定义部件，`scope: definition`）

```cpp
// 先包含自己的头文件，再按需包含其它头文件
#include "demo/point.h"

namespace demo {

point::point(int32_t x, int32_t y) : x_(x), y_(y) {}

int32_t point::x() const noexcept {
  return x_;
}

void point::set_x(int32_t value) noexcept {
  x_ = value;
}

void point::move(int32_t dx, int32_t dy) noexcept {
  x_ = x_ + dx;
  y_ = y_ + dy;
}

}  // namespace demo
```

规则（除非目标仓库另有约定，§12）：

1. **头文件保护**用 `#ifndef` / `#define` / `#endif`，宏名取「命名空间 + 文件名」的大写下划线形式（`DEMO_POINT_H`）；`#pragma once` 同样可用，但一个仓库里要统一。`#endif` 后面写上 `// DEMO_POINT_H` 便于阅读。
2. **包含顺序**：标准库 → 第三方 → 项目内，组内按字典序；`#include "…"` 用从包含根算起的相对路径，不要用 `../` 上跳。
3. **命名空间**：`# namespace demo` 映射为 `namespace demo { … }`，`.h` 与 `.cpp` 用同一个名字，闭合处写 `}  // namespace demo`。没有 `# namespace` 时，按 §3.3 推导一个名字。
4. **一个文件一个「主类型」**：文件名对应的那个类型；其它需要的类型用 `#include` 拿来，不要顺手再声明一遍。
5. **成员顺序与源文件一致**（`access specifiers` 内部保持源顺序即可，不需要把 `public` 全部提到最前；但同一个访问级内不要重排）。
6. 说明散文不进产物（`xl-emit-ts.md` §1 同理）。若目标仓库希望把成员说明写成注释，写在该成员上一行 `//`，内容取自源文件的散文——这是可选项，不是结构校验的一部分。
7. 本文示例里的 `noexcept` 只是**示意**：只在你能保证该成员不抛异常时加（简单字段读写可以；会 `throw`、会分配、会调外部 API 的成员不要加）。标准库风格的代码普遍标 `noexcept`，但一致性比覆盖率重要：一个单元里要么都标（能标的），要么都不标。

---

## 3. 依赖与命名空间

### 3.1 `# dependencies` 的 ```` ```xl ```` 块

每行 `import { … } from "./util.xl.md"` 生成一条 include：去掉 `.xl.md` 后缀、按 `--naming` 变换基名，**然后按「被包含的那个产物在 `dist/cpp/` 下的相对路径」拼路径**。

````md
# dependencies
```xl
import { level, describe } from "./util.xl.md"
```
````

`pkg/demo.xl.md` 里的这行 `import` 指向 `pkg/util.xl.md`，它的产物是 `dist/cpp/pkg/util.h`：

```cpp
#include "pkg/util.h"
```

* **规则**：`#include` 的路径 = 目标产物相对于 `<out>/cpp/` 的路径（`xl_context` 报出的产物路径去掉 `<out>/cpp/` 前缀）。**不要**由命名空间推导目录名——§3.3 的命名空间与目录层级是两件互不相干的事，`pkg/demo.xl.md` 用 `# namespace demo` 时路径仍是 `pkg/…`。
* 引入根由构建文件提供（§11：`target_include_directories(... "<out>/cpp")`），所以同一棵树里的任意文件都能用同一条路径包含到同一个头文件，与被包含者 / 包含者各自在哪一层无关。
* 导入的名字决定你要**用到**什么：只用到**类名**（且只以引用 / 指针出现、不访问成员）时可以改成前置声明（`namespace demo { class point; }`，命名空间取该类型所在的那个），用到成员、值、或枚举值时必须 include 完整定义（`enum class` 的前置声明还要写底层类型，得不偿失）。
* 同一个目标模块已在手工 include 里出现时**不要重复生成**（与 `xl-emit-ts.md` §3 同规则）。
* 依赖文件不参与本次构建、也不会被自动编译（`xl-cli.md` §3.2）：它引出的符号要在目标工程里真实存在，否则链接失败。

### 3.2 `# dependencies` 的 ```` ```ts ```` 块与 `## cpp` 段

* ```` ```ts ```` 块是**宿主语言**的依赖（`lodash`、`node:fs`…），C++ 里没有对应物：
  * 若该依赖表达的能力在目标工程里有等价物（如 `node:fs` → `<fstream>`），按 `### cpp` / `## cpp` 段的说明或目标仓库惯例替换；
  * 若没有等价物，**显式告诉调用方**（`xl_emit` 之后在会话里说明），不要静默丢掉——一个引用了它的函数体会因此无法实现。
* `# dependencies` 下的 `## cpp` 段（若存在）给出该单元的 include 清单与第三方依赖，**以它为准**（§12）。

### 3.3 命名空间推导（按顺序取第一条命中）

| 顺序 | 来源 | 结果 |
| --- | --- | --- |
| 1 | 作者在 `## cpp` 段或类标题散文里明确写了命名空间 | 照写 |
| 2 | `xl_context` 的 `targets.cpp.namespace`（若配置给了） | 照写 |
| 3 | `# namespace demo` | `namespace demo` |
| 4 | 目标工程已有约定（既有实现的头文件里是什么就是什么） | 照既有 |
| 5 | 都没有 | 由源文件相对目录推导，`pkg/demo.xl.md` → `pkg::demo`；推导不出就用文件基名 |

* `# namespace` 的**名字**在 xl 里不产生代码（`xl-emit-ts.md` §2 的同类规则），所以它是「推荐值」而不是强制值：落在既有工程里时要服从该工程。
* **命名空间不决定任何路径**：产物路径由 `xl_context` 给出，`#include` 路径由相对 `<out>/cpp/` 的位置给出（§2.1、§3.1），文件名由 `--naming` 决定。三者互相独立，别用命名空间去推目录。
* 内部辅助一律放进匿名命名空间（`namespace { … }`）或作为 `private` 成员，不要污染公开命名空间。

---

## 4. 类型映射

| 源类型 | C++ | 例 |
| --- | --- | --- |
| `int` | `int32_t`（配 `#include <cstdint>`；需要更宽时在 `## cpp` 段声明） | `x:int` → `int32_t x` |
| `float` | `float` | |
| `double` / `number` | `double` | |
| `bool` | `bool` | |
| `string` | `std::string`（只读、不持有的参数可用 `std::string_view`） | `path:string` → `const std::string& path` |
| `void` | `void` | |
| `any` | 优先 `std::any`；已知具体类型时用该类型 | |
| `null` / `undefined` / `never` / `unknown` | `std::nullptr_t` / `std::nullopt_t` / `void` / `std::any`（见 §4.2） | |
| `object` | 有对应 IR 类型就用它；否则模板 `T` | `object` → 优先指向 IR 里的那个 `class` / `interface` |
| `Array<T>` / `T[]` | `std::vector<T>` | `Array<Array<int>>` → `std::vector<std::vector<int32_t>>` |
| `ReadonlyArray<T>` | `std::vector<T>`（只读性由 `const` 引用 / `const` 成员函数表达，不另造类型） | |
| `Map<K,V>` | `std::map<K, V>`（要哈希语义时 `std::unordered_map`，需在 `## cpp` 段说明） | `Map<string,int>` → `std::map<std::string, int32_t>` |
| `Set<T>` | `std::set<T>` / `std::unordered_set<T>` | |
| `Promise<T>` | `std::future<T>` | 见 §5.5 |
| `Generator<T>` / `AsyncGenerator<T>` | `std::generator<T>`（C++23）或自定义生成器 | 见 §5.4 |
| `Record<K,V>` | `std::map<K, V>` | |
| `Partial<T>` / `Readonly<T>` | `T`（C++ 没有类型级映射；语义写进注释或 `## cpp` 段） | |
| `T?` | `std::optional<T>`（见 §4.3） | |
| `(a:int)=>void` | `std::function<void(int32_t)>`（无捕获、性能敏感处用函数指针 / 模板参数） | |
| `A \| B` | `std::variant<A, B>`（见 §4.4） | |
| 字面量类型 `"printable"` / `2` / `true` | 值类型 `std::string` / `int32_t` / `bool`，约定值写进注释或 `constexpr` 常量 | |
| 其它具名类型 | 原样保留（`level` → `level`，落在同一命名空间） | |

补充规则：

* 容器与智能指针按 `const` 引用传参、按值返回（NRVO / 移动）；不要用裸指针表达「可能为空」，那是 `std::optional` 的工作。
* 跨 TU 共享的常量优先 `inline constexpr`（C++17），避免 ODR 问题（§5.2）。
* 类型映射只作用于**类型标注**；`# type` 等号右侧与 `- case green = 2` 右侧是**原文**（语法 §6、§9），要逐字翻译而不是套表——它们**不参与**类型解析。

### 4.1 泛型参数

| 源 | C++ |
| --- | --- |
| `<T>` | `template <typename T>` |
| `<T extends object>` | `template <typename T>`（C++ 里没有隐式「引用类型」约束，约束天然满足） |
| `<K extends string, V = any>` | `template <typename K, typename V = std::any>` |
| 其它 `extends X` 且 `X` 是 IR 里的 interface | C++20 起可写成 `template <typename T> requires X<T>`，或给 `static_assert`；C++17 下退化成无约束并加注释 |

* 泛型（模板）成员的**定义必须留在 `.h`**：模板在实例化点需要完整定义，放进 `.cpp` 会链接失败。这是 C++ 与 ts 差别最大的一处，也是 `.cpp` 常常只承载非模板成员的原因。
* `T` 的成员访问（`a.x`）在模板里要保证 `T` 有该成员；不确定时用 `if constexpr` 或要求调用方传入满足约束的类型，并把假设写进注释。

### 4.2 「没有对应物」的四个类型

它们只在源文件明确写了的时候出现；按下面取值，并把原因写进该处的注释：

| 源 | C++ | 说明 |
| --- | --- | --- |
| `null` | `std::nullptr_t` | 只在字面量 / 哨兵语义下有意义；一般应改用 `std::optional<T>` |
| `undefined` | `std::nullopt_t` 或 `std::optional<T>` | 可选成员的「无值」态 |
| `never` | `void` + 注释，或 `[[noreturn]]` 函数 | 表示「不返回」 |
| `unknown` | `std::any` 或模板参数 `T` | 需要类型擦除时用 `std::any` |

### 4.3 可选性 `T?`

| 位置 | C++ |
| --- | --- |
| 字段 `## field note?:string` | `std::optional<std::string> note_;` + 读写器（用 `std::optional` 表达缺失，不要用 `""` 之类的哨兵值） |
| 参数 `encoding?:string` | `const std::optional<std::string>& encoding = std::nullopt`，或重载一个少参版本 |
| 参数带默认值 `x?:int = 0` | `int32_t x = 0`（有默认值时不需要 `std::optional`） |
| 返回类型里的 `T?` | `std::optional<T>` |
| 显式写成 `T \| undefined` | 同 `T?`：`std::optional<T>`（**不要**用 `std::variant<T, std::monostate>`，除非该联合另有分支） |

### 4.4 联合类型 `A | B`

* 只有 `T | undefined` → `std::optional<T>`（§4.3）。
* 其它多分支联合 → `std::variant<A, B>`；分支里含字面量类型时，为每个字面量值定义 `constexpr` 常量或 `struct`，并把「这是哪一支」的判定逻辑写在注释里。
* 联合只出现在参数 / 返回值、且分支语义上等价（如 `string | string[]`）时，允许改用两个重载——但要在注释里说明这是一次有意的取舍。

---

## 5. 逐构造映射

下表是默认模板。**成员名（含 accessor 名）必须保留**，它们是结构回读校验的对象之一；改名等价于让 `xl_emit` 报 `E4002`。

| 源 | C++ 形态 |
| --- | --- |
| `# type N = 原文` | 先看右侧的意图：`using N = …;` / `enum class` / `struct`（§5.2） |
| `# const` | `inline constexpr` / `extern const` + `.cpp` 定义（§5.2） |
| `# method` | 自由函数，定义进 `_module.cpp`（§5.3） |
| `# enum` | `enum class` + 显式底层类型（§5.2） |
| `# interface` | 抽象基类 + 纯虚函数 + `virtual ~`（§6） |
| `# class` | `class`，字段私有 + 读写器，方法非虚（除非 `implements`）（§7） |
| `## field` | `private` 数据成员 + 同名的 const 读 / 写方法（§7.2） |
| `## property` | `private` 后备字段 + 读方法 `<name>()` / 写方法 `set_<name>()`（§7.3） |
| `## method` | 成员函数，`static` 用 `static`，可见性用访问级（§7.4） |
| `## constructor` | 构造函数 + 成员初始化列表（§7.5） |
| `# statement` | 命名空间内的匿名初始化对象（§5.6） |

### 5.1 可见性映射

| 源 | C++ |
| --- | --- |
| 一级声明省略 / `# public` | 公开（头文件里直接可见；不需要 `export` 之类的前缀） |
| `# private` | 放进匿名命名空间、或 `static`（自由函数 / 常量）；类型则放进 `namespace <file>::internal` |
| `# protected` | 一级声明上非法（`E1202`），不会出现 |
| 类成员 `public` / `protected` / `private` | 对应的 `public:` / `protected:` / `private:` 访问级 |
| 接口成员上的可见性 | 忽略（接口成员恒公开，`xl-emit-ts.md` §6.2 同规则） |

### 5.2 `# type` / `# const` / `# enum`

````md
# type MemberKind = "field" | "property" | "method"

# const MAX_DEPTH:int = 8

# const RULES:ReadonlyArray<string>
```ts
[
  "E1001",
  "E1002",
]
```

# enum color
- case red
- case green = 2
- case blue
````

```cpp
// demo_module.h（片断：假设已经有 #include <cstdint> / <string> / <vector>）
namespace demo {

// 字面量联合：C++ 里用 enum class 最贴近（成员名保留，字面量成为枚举值）
enum class MemberKind { field, property, method };

// 字面量能折叠时用 constexpr（值语义、可内联）
inline constexpr int32_t MAX_DEPTH = 8;

// 初始值需要运行时构造（这里是一个 vector）时，用 inline const 让它跨 TU 唯一
inline const std::vector<std::string> RULES = {
    "E1001",
    "E1002",
};

enum class color : int32_t {
  red,
  green = 2,
  blue,
};

}  // namespace demo
```

* `# type` 的右侧是原文，先判断它的**意图**再选 C++ 形态：字面量联合 → `enum class`；`A | B` 类型联合 → `using N = std::variant<A, B>;`；结构化类型（`{ x:int; y:int }` 之类的文字描述）→ 在本文件定义一个 `struct N { … };`；真的只是别名 → `using N = <映射后的类型>;`。最省事的兜底是 `using N = std::string;` 并加注释，但那只适合「当作标识符用」的场合。
* `# const` 的初始值来自内联 `= <expr>` 或 `ts` 代码块（`xl-emit-ts.md` §5.2 同规则）；把它翻译成 C++ 初值列表：
  * 全部是字面量 → `inline constexpr <type> NAME = …;`
  * 需要构造 / 分配（`[]`、`new Map()`、函数调用）→ `inline const <type> NAME = …;`（C++17 起 `inline` 变量跨 TU 唯一，不需要再写一个 `.cpp`）
  * 若目标仓库坚持「头文件只放声明」→ 改成 `.h` 里 `extern const <type> NAME;`、`.cpp` 里定义，此时该单元的 `.cpp` 一定被计划（`requires: "bodies"`），不要漏交。
* `# const` 名字保留源文件的大小写，除非目标仓库的常量命名规范另有要求（§12）：`MAX_DEPTH` 就写 `MAX_DEPTH`，不要擅自改成 `kMaxDepth`。
* `# enum`：
  * 一律 `enum class`（避免 `color::red` 与其它枚举的 `red` 撞名，也避免隐式转换）；显式写底层类型 `: int32_t`，没有 `- case … = <值>` 时从 0 开始递增。
  * `- case green = 2` 的右侧逐字直译：`green = 2,`；后面的 `blue` 若与某个显式值撞车（`green = 2` 与 `blue` 这种组合），**必须**给 `blue` 一个显式值并加注释说明，否则 C++ 里两个枚举值同值虽合法但语义含混。
  * 成员之间不空行、不带尾随逗号都不必强求——那是 ts 打印器的字节契约，C++ 侧只要可读；建议一行一个成员、尾随逗号统一加。

### 5.3 `# method`

````md
# method loadText:(path:string, encoding?:string)=>string
```ts
return rf(path, encoding ?? "utf8");
```
````

```cpp
// demo_module.h
namespace demo {

std::string load_text(const std::string& path,
                      const std::optional<std::string>& encoding = std::nullopt);

}  // namespace demo
```

```cpp
// demo_module.cpp
namespace demo {

std::string load_text(const std::string& path,
                      const std::optional<std::string>& encoding) {
  // 原 ts 体：return rf(path, encoding ?? "utf8");
  std::ifstream in(path, std::ios::binary);
  return std::string(std::istreambuf_iterator<char>(in), {});
}

}  // namespace demo
```

* **名字**：`.h` / `.cpp` 里出现的是同一个 C++ 名字，别在一边 snake_case、一边 camelCase。函数名建议 `snake_case`（与 cpp 目标的文件命名风格一致）。
* **参数名与个数必须保留**：结构回读会核对参数个数（允许重载），找不到同名成员会报 `E4002`。
* **可选参数**用默认实参，且默认实参只写在 `.h`；`.cpp` 里不重复写默认值。
* **泛型方法**：`# method pickFirst:<T>(items:Array<T>)=>T` → `template <typename T> T pick_first(const std::vector<T>& items);`，**定义留在 `.h`**。
* **`async`**：见 §5.5。**体内 `yield`**：见 §5.4。
* `# private method` → 放进匿名命名空间（`namespace { … }`）或写 `static`；不要用 `private`（文件级没有这个概念）。

### 5.4 生成器（体内出现 `yield`）

`xl-emit-ts.md` §9.1 的判定同样适用：默认语言块体内出现 `yield`（忽略字符串与注释里的）即按生成器处理。

````md
# method tick:()=>int
```ts
yield 1;
yield 2;
```
````

C++20/23 起（推荐）：

```cpp
// demo_module.h
#include <generator>

namespace demo {

std::generator<int32_t> tick();

}  // namespace demo
```

```cpp
// demo_module.cpp
namespace demo {

std::generator<int32_t> tick() {
  co_yield 1;
  co_yield 2;
}

}  // namespace demo
```

C++17 或工具链没有 `<generator>` 时，用「惰性序列」替代，并保证语义等价（调用时才产生值、可多次迭代按 §12 决定）：

```cpp
// 把 yield 序列搬进一个 std::vector 并在调用时返回（急切），
// 或提供一个 begin()/end() 的迭代器类（惰性）。无论哪种：
//  - 函数名与参数个数保持不变；
//  - 返回类型在 .h 里出现（结构回读会在 .h 里找成员名）；
//  - 在注释里写清是急切还是惰性，避免调用方假设错误。
std::vector<int32_t> tick();
```

* 返回类型名（`std::generator<int32_t>` / 自定义类名）要写进 `.h`，`xl_verify` 的成员名扫描读的是声明部件。
* `yield` 出现在**访问器**体内时，该访问器也按生成器处理（`xl-emit-ts.md` §8 规则 5）：C++ 侧同样给它一份生成器签名，不要偷偷改成一次性返回 `T`。

### 5.5 `async`

````md
## method load:async (url:string)=>string
````

```cpp
// .h（片断：假设已经有 #include <optional> / <string>）
std::future<std::string> load(const std::string& url);
```

```cpp
// .cpp
std::future<std::string> load(const std::string& url) {
  return std::async(std::launch::async, [url] {
    // 原 ts 体：const r = await fetch(url); return r.text();
    return fetch_text(url);
  });
}
```

* `Promise<T>` 已经出现时不要重复包裹（`xl-emit-ts.md` §9.1 同规则）：源里写 `Promise<string>` 就是 `std::future<std::string>`。
* 目标仓库有协程框架（`asio::awaitable`、`cppcoro::task` 等）时优先用它，并把选择写进注释；`std::async` 只作为无框架时的兜底。
* 宿主语言才有的能力（`fetch`、`await`、事件循环）在 C++ 里没有等价物时：**不要伪造**，改成明确失败的实现（抛 `std::logic_error("未实现：依赖宿主 …")`）或在会话里向调用方说明需要替换实现。静默返回空值是更坏的选择。

### 5.6 `# statement`

C++ 没有「模块加载时执行一次」的语句，用命名空间内的匿名初始化对象表达：

````md
# statement
进程入口。
```ts
Main(process.argv.slice(2));
```
````

```cpp
// demo_module.cpp（这个单元一定有 .cpp：# statement 一定有可执行内容）
namespace demo {
namespace {

// [[maybe_unused]]：这个对象只为「加载时执行一次」而存在，没人读它
[[maybe_unused]] const bool kStatement1 = [] {
  // 原 ts 体：Main(process.argv.slice(2));
  const std::vector<std::string> args{/* … */};
  Main(args);
  return true;
}();

}  // namespace
}  // namespace demo
```

* 多个 `# statement` 段**按源文件顺序**各成一个对象（`kStatement1`、`kStatement2`…），初始化顺序在同一个 TU 内是确定的；跨 TU 的顺序不确定，所以不要依赖多个单元之间的先后。
* 对象名只是本文件内部的记账，不要用会与 IR 成员冲突的名字；`static` 变量的初始化顺序问题（静态初始化顺序惨案）要留意：语句体内若引用了别的 TU 的全局对象，**改用函数内 `static` 或显式初始化入口**，并在注释里说明。
* 已经声明过的 `Main` 等符号要先 include 对应头文件；`# statement` 不声明名字，所以它不参与结构校验（`xl-cli.md` §3.4）。

---

## 6. `# interface` → 抽象基类

````md
# interface printable

## readonly field kind:"printable"

## readonly field id:string

## field note?:string

## method print:()=>string
````

```cpp
// printable.h
namespace demo {

class printable {
 public:
  virtual ~printable() = default;

  // 只读字段 -> 纯虚 const 读方法；readonly 表达为「没有 set」
  virtual const std::string& kind() const = 0;
  virtual const std::string& id() const = 0;

  // 无 readonly 的字段 -> 读 + 写
  virtual std::optional<std::string> note() const = 0;
  virtual void set_note(const std::optional<std::string>& value) = 0;

  virtual std::string print() const = 0;
};

}  // namespace demo
```

* `# interface X extends Y` → `class X : public Y`；`# interface` 不接受 `implements`（语法 §10）。
* **一定要有 `virtual ~X() = default;`**：接口要被多态删除，缺虚析构是 UB。
* 成员一律 `= 0`（纯虚）：接口只声明、不带函数体（`xl-check.md` 的 `E1304` 保证源里也不会给体），所以 `.h` 就是全部产物，**不会有 `.cpp`**（`layout=type` + `requires: "bodies"`）。
* `## property` 在接口里是属性签名：只有 `### get`（没有 `### set`）时是只读 → 只给 `const` 读方法；挂了 `### set` 时给读 + 写。语义与 `xl-emit-ts.md` §6.2 的 `readonly` 判定完全一致。
* 接口成员上写 `private` / `protected` / `static` 在源里不报错（`xl-check.md` §3.2 C），产物里**忽略**它们。

---

## 7. `# class`

### 7.1 类头

````md
# class box<T extends object> extends point implements printable
````

```cpp
// box.h
namespace demo {

template <typename T>
class box : public point, public printable {
 public:
  box();
  ~box() override = default;

  // printable 的成员实现（名字、参数个数与接口一致）
  const std::string& kind() const override;
  const std::string& id() const override;
  std::optional<std::string> note() const override;
  void set_note(const std::optional<std::string>& value) override;
  std::string print() const override;

  // …本类自己的成员…

 private:
  T value_{};
};

}  // namespace demo
```

* 三段顺序照源文件：`template <…>` → `: public <extends>` → `, public <implements…>`。
* `implements` 的每个接口都要在成员上写 `override`；接口成员实现不全 → 该类是抽象类，`E1105` 会在检查阶段提示（可选字段不强制）。
* 实现继承的基类指针 / 引用有多态删除风险时，基类要有虚析构：`extends` 的类若在本单元可见且可能被多态使用，加 `virtual ~<name>() = default;`。
* `# private class helper` → 不进公开头文件的 API 面：放进 `namespace <file>::internal { … }` 或直接放进匿名命名空间所在的 `.cpp`（前提是它不作为任何公开签名的一部分出现）。

### 7.2 字段

````md
## field x:int = 0

## static readonly field ORIGIN:string = "0,0"

## private field raw:int = 0

## field note?:string
````

```cpp
// .h（片断：只画出这些成员带来的声明，其余成员略）
 private:
  int32_t x_ = 0;
  int32_t raw_ = 0;
  std::optional<std::string> note_;

 public:
  static constexpr const char* ORIGIN = "0,0";

  int32_t x() const noexcept { return x_; }
  void set_x(int32_t value) noexcept { x_ = value; }

  std::optional<std::string> note() const { return note_; }
  void set_note(const std::optional<std::string>& value) { note_ = value; }
```

* 字段名保留源文件里的名字（结构校验的对象），后缀 `_` 只加在私有数据成员上，**getter / setter 的名字里不带后缀**（`x()` / `set_x`）。
* 默认把数据成员设为 `private` + 读写器，是 C++ 侧与本项目惯例最一致的做法（也和 `ts` 产物里 `property` 展开成字段 + 访问器的形状接近）。
  * `readonly` 字段（`readonly field kind:"printable"`）→ 只给 `const` 读方法，不给 `set_`。
  * `private field` → 数据成员保持 `private`，并且**不生成**公开读写器；若 IR 里没有别的成员用到它，就是一个纯粹的内部状态字段。
  * 目标仓库明确用「公开数据成员」风格（POD / `struct`）时，可以改成 `struct` 式公开字段 + 保持字段名不变：这是 §12 的取舍，但**不能**只保留 `x_` 而丢掉 `x` 这个名字——成员名集合是校验对象。
* `static` → `static` 成员；能被常量表达式折叠时优先 `static constexpr`（类内即可定义，C++17 起无需类外定义），否则在 `.cpp` 里补类外定义：`const std::string box::thing_ = …;`。
* 初始值翻译：
  * `= []` → `= {};`（值初始化）
  * `= new Map()` → `= {};` 或 `std::map<K, V>{}`，不要真的 `new`
  * `= "…"` → `= "…";`（`std::string` 可直接从字面量构造）
  * 复杂初值（函数调用、需要 try）→ 构造函数的成员初始化列表里给，**不要**在类内写一个可能抛异常的复杂初始化器（也可以用 `= [] { … }()` 的立即调用 lambda，但要在注释里说明）
* 中文 / 非 ASCII 的字符串字面量：源文件要求 UTF-8（语法开头），`u8"…"` 在 C++20 起是 `char8_t` 会带来类型麻烦，**建议保持普通 `"…"` 并确保编译器与源文件都是 UTF-8**。

### 7.3 `property` 与访问器

`xl-emit-ts.md` §8 的形状在 C++ 里几乎可以一一对应，只是命名换成「读方法 `<name>()`、写方法 `set_<name>()`」（或目标仓库的惯用前缀）。

````md
## property label:string = "unnamed"
### get
### private set

## property score:int
### get
```ts
return this.raw;
```
### set
```ts
if (value < 0) throw new Error("score must be >= 0");
this.raw = value;
```
````

```cpp
// .h
 private:
  std::string label_ = "unnamed";
  int32_t raw_ = 0;

 public:
  // label：get 公开、set 私有 —— 只在类内可写
  const std::string& label() const noexcept { return label_; }

 private:
  void set_label(const std::string& value) noexcept { label_ = value; }

 public:
  // score：计算属性 —— 没有后备字段，get 直接读 raw_
  int32_t score() const;
  void set_score(int32_t value);
```

```cpp
// .cpp
int32_t box::score() const {
  return raw_;
}

void box::set_score(int32_t value) {
  if (value < 0) {
    throw std::invalid_argument("score must be >= 0");
  }
  raw_ = value;
}
```

规则汇总（与 `xl-emit-ts.md` §8 同源的判断，只是落到 C++）：

| 源形态 | C++ |
| --- | --- |
| 有初始值 / 无 `### get` / getter 是生成器 | 生成后备字段 `#<name>` → `private: <T> <name>_;` |
| getter 有体且无初始值 | 计算属性：**不**生成后备字段，getter 体照译 |
| 访问器只有标题没有代码块 | 合成直通实现：`return <name>_;` / `<name>_ = value;` |
| 不挂访问器 | 等价于一对空访问器：后备字段 + 直通 `<name>()` / `set_<name>()` |
| `### private set` / `### protected set` | 放进对应的访问级（`private:` / `protected:`） |
| 只有 `### get` | 不合成 setter（只读） |
| `### get` / `### set` 体内 `yield` | 该访问器按生成器处理（§5.4） |
| 访问器书写顺序任意 | 产物恒按「读在前、写在后」排列（语法 §14） |

* **`property` 的成员名不加 `?`**（`?` 属于访问器语义，语法 §13）：`std::optional<T>` 由类型标注决定，不由 `?` 决定。
* 名字：数据成员 `<name>_`，读方法 `<name>()`，写方法 `set_<name>(value)`。**读方法不要叫 `get_<name>` 再配一个 `set_<name>`**——统一用 `name()` / `set_name()` 更贴近标准库与既有 C++ 惯例；同一套代码里保持一种即可，一旦选定就不要在一个单元里混用。
* 计算属性的 getter 若只返回一个成员（`return this.raw;`），可以直接在 `.h` 里内联 `int32_t score() const noexcept { return raw_; }`（省一次函数调用，也少一个 `.cpp`）；ts 打印器在同样形状下也会把它压成一行（`xl-emit-ts.md` §11），这是两侧都鼓励的取舍。
* `throw` 的翻译：`new Error("…")` → `std::invalid_argument`（参数错）/ `std::runtime_error`（运行时错）/ `std::logic_error`（编程错），三选一后保持一致；不要抛裸 `std::exception`。

### 7.4 `method`

````md
## method print:()=>string

## private method clamp:(v:int)=>int

## static method create:()=>int

## method chunk2:(list:Array<int>)=>Array<Array<int>>
````

```cpp
// .h
 public:
  std::string print() const;
  static int32_t create();
  std::vector<std::vector<int32_t>> chunk2(const std::vector<int32_t>& list) const;

 private:
  int32_t clamp(int32_t v) const;
```

* 常量成员函数：源里没有修改任何字段的方法（含只读的 `print` / `chunk2`）标 `const`；判定不了就不标，**不要**为了好看滥标（标错会让调用方编译失败）。
* `static` → `static`（不进成员初始化列表，`.cpp` 里用 `<Class>::<name>` 定义）。
* `async` / `yield` / 泛型 / 参数可选，规则同 §5.3–§5.5。
* 名字与参数个数是结构校验对象；**重载**（同名的不同参数个数）是允许的（`xl-check.md` 的 `E1205` 不报），但重载之间的语义差别要写注释。

### 7.5 `constructor`

````md
## constructor:(x?:int, y?:int)=>void
```ts
this.x = x ?? 0;
this.y = y ?? 0;
```
````

```cpp
// .h
 public:
  point(int32_t x = 0, int32_t y = 0);
```

```cpp
// .cpp
point::point(int32_t x, int32_t y) : x_(x), y_(y) {}
```

* 用**成员初始化列表**而不是「构造体内赋值」；`?? 0` 的语义由默认实参表达，不需要 `std::optional`（除非源里 `x?` 与「0 也有意义」并存，此时用 `std::optional<int32_t>` 并让调用方显式给 `std::nullopt`）。
* 没有给出任何构造参数时，写 `point() = default;`（并在类内让字段自带初始化器）。
* **默认实参只写在 `.h`**。
* `constructor` 的可见性写在成员前（`## private constructor:()=>void` → `private:` 下的构造函数）；`static` / `readonly` 上构造函数是 `E1202`，源里不会出现。
* 一个类只有一个 `constructor`（多个是 `E1206`）。
* 类的成员与构造函数**顺序照源文件**，不要为了「构造函数放最前」的阅读习惯给构造器搬家——IR 顺序由源决定，产物同序更省心。

---

## 8. 成员排列与空行

C++ 侧没有字节契约，目标是**可读且与源文件顺序一致**：

* 每个访问级（`public:` / `protected:` / `private:`）内部保持源文件顺序；进出一个访问级不要来回跳（源里 `public` 成员与 `private` 成员交错出现时，允许合并成一段 `public:` + 一段 `private:`，但同一名的声明不能分裂）。
* 数据成员集中放在类尾（`private:`）是最常见的做法；若源文件里字段与方法交错、而目标仓库没规定，可按源顺序走「一段声明 + 一段实现」的交错。
* 相邻的声明之间不空行；不同的逻辑组（字段组 → 访问器组 → 方法组）之间空一行。
* 类头与第一个成员、最后一个成员与 `};` 之间不空行（和 ts 产物一致）。
* `.cpp` 里成员定义之间空一行，顺序尽量与 `.h` 一致，便于对照。

---

## 9. 结构回读：生成者必须自己先对一遍

`xl_verify` / `xl_emit` 不解析 C++，只做轻量符号扫描（`xl-cli.md` §3.4）。提交前按这张表核对，能省掉一次 `E4002` 往返：

| 核对 | 对 C++ 的要求 |
| --- | --- |
| 类型集合 | IR 里每个 `enum` / `interface` / `class`，在**它对应的那个部件**里必须出现（声明或被提到） |
| 成员名集合 | **声明部件（`.h`）必须提到每个成员名**：字段名（`x`）、读写器名（`x` / `set_x`）、方法名（`print`）、接口成员名 |
| 成员名集合 | 定义部件（`.cpp`）只要求提到它实现的**类型名**，以及它确实写出来的成员——所以模板成员只出现在 `.h` 是允许的 |
| 参数个数 | 产物里同名成员的参数个数必须与 IR 里的某个声明一致（允许重载） |

实践建议：

* 成员名一律**保留源文件里的拼写**：字段 `x` 的私有数据成员写成 `x_`（带后缀的形式被扫到即可），而读写器用**不带后缀**的 `x()` / `set_x()` —— 「后缀只加在私有数据成员上」是最稳的约定（§7.2）。
* 只写声明、把定义放 `.cpp` 时，`.h` 里每个成员的声明都不能漏——这是最容易踩的一条。
* 一个单元有 `.cpp` 时，**两个部件都要交**；少交一个是 `E4002`，多交计划外的路径是 `E2001`（`xl-cli.md` §3.4）。
* 改完先 `xl_verify` 再 `xl_emit`：前者不写盘，成本低。
* **`CMakeLists.txt` 不在这张表的任何一项里**：它不在计划的产物清单里，`xl_verify` / `xl_emit` 都不看它一眼。它的位置、内容与构建树隔离由 §11 的约定负责，不由 xl 校验。

---

## 10. 完整示例

````md
# namespace demo

# enum level
- case debug = 10
- case info = 20

# class point

## field x:int = 0

## method move:(dx:int, dy:int)=>void
```ts
this.x = this.x + dx;
```

## constructor:(x?:int)=>void
```ts
this.x = x ?? 0;
```

# class cache<K extends string, V = any>

## field hits:int = 0

## field data:Map<K,V>
```ts
new Map()
```
````

```cpp
// demo_module.h
#ifndef DEMO_MODULE_H
#define DEMO_MODULE_H

#include <cstdint>

namespace demo {

enum class level : int32_t {
  debug = 10,
  info = 20,
};

}  // namespace demo

#endif  // DEMO_MODULE_H
```

```cpp
// point.h
#ifndef DEMO_POINT_H
#define DEMO_POINT_H

#include <cstdint>

namespace demo {

class point {
 public:
  explicit point(int32_t x = 0) : x_(x) {}

  int32_t x() const noexcept { return x_; }
  void set_x(int32_t value) noexcept { x_ = value; }

  void move(int32_t dx, int32_t dy) noexcept;

 private:
  int32_t x_ = 0;
};

}  // namespace demo

#endif  // DEMO_POINT_H
```

```cpp
// point.cpp
#include "demo/point.h"

namespace demo {

void point::move(int32_t dx, int32_t dy) noexcept {
  x_ = x_ + dx;
}

}  // namespace demo
```

```cpp
// cache.h —— 这个单元只有 .h：cache 只有类内初值，没有需要放 .cpp 的成员
#ifndef DEMO_CACHE_H
#define DEMO_CACHE_H

#include <any>
#include <cstdint>
#include <map>
#include <string>

namespace demo {

template <typename K, typename V = std::any>
class cache {
 public:
  cache() = default;

  int32_t hits() const noexcept { return hits_; }
  void set_hits(int32_t value) noexcept { hits_ = value; }

  const std::map<K, V>& data() const noexcept { return data_; }

 private:
  int32_t hits_ = 0;
  std::map<K, V> data_{};
};

}  // namespace demo

#endif  // DEMO_CACHE_H
```

（`demo_module.cpp` 只在模块级 `# method` / `# const` / `# statement` 需要时才出现；`# statement` 的处理见 §5.6。要能编译出东西，还需要一份 `<out>/cpp/CMakeLists.txt`，见 §11。）

---

## 11. 构建与产物布局

**构建文件不在仓库根，就在生成树里**：`<out>/cpp/CMakeLists.txt`。它不由 `xl` 生成（`xl_plan` 里没有它、`xl_emit` 不校验它、`--clean` 不会删它，见 §1 的「构建文件」一行），而是**由你写、由你维护**：目标工程需要什么、编译标准是什么、要不要第三方依赖，都在这里落定。

```text
<repo>/                                    ← 仓库根永远干净：没有 CMakeLists.txt、没有 CMakeCache.txt、没有 CMakeFiles/
  pkg/demo.xl.md                           ← 源
  dist/                                    ← 整棵 gitignore
    cpp/
      CMakeLists.txt                       ← 你写的构建文件（常驻，xl 不碰）
      pkg/point.h  pkg/point.cpp  …        ← xl 的产物（§1、§2）
      build/                               ← 构建树：一切中间产物只准进这里
      .xl/                                 ← xl 的增量 cache 与历史版本归档
```

### 11.1 `CMakeLists.txt`（放在 `<out>/cpp/`）

```cmake
cmake_minimum_required(VERSION 3.20)
project(xl_generated CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 产物是 .h 与 .cpp，分布在按源目录层级展开的子目录里
# 排除 .xl/：那里是 xl 的历史版本归档（同样的 .cpp 后缀），卷进来会重复定义符号
file(GLOB_RECURSE GENERATED_SOURCES CONFIGURE_DEPENDS
     "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
     "${CMAKE_CURRENT_SOURCE_DIR}/*.h")
list(FILTER GENERATED_SOURCES EXCLUDE REGEX "/\\.xl/")

add_library(xl_generated STATIC ${GENERATED_SOURCES})

# 引入根 = 本目录（dist/cpp），与 §3.1 的 include 约定一致
target_include_directories(xl_generated PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")

# 最终产物也收在构建树里；多配置 generator（Visual Studio 之类）会再加一层 <Config>/
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
```

* 第三方依赖：xl 侧的 `## cpp` 段说需要什么（§3.2），在这里用 `find_package` + `target_link_libraries` 落实。宿主语言的能力（`fetch`、事件循环）没有 C++ 等价物时，不要假装它能链接——按 §5.5 改成明确失败并在此处注释说明。
* **不要** `add_subdirectory` 到仓库里别的位置，也不要在模板里依赖 `CMAKE_SOURCE_DIR`（本模板只用 `CMAKE_CURRENT_SOURCE_DIR` 与 `CMAKE_BINARY_DIR`，两者都落在 `dist/cpp/` 之内）。
* 第一次生成时 `dist/cpp` 里可能一个 `.cpp` 都没有（例如全部是 header-only 的 `# interface`）：`GLOB` 会得到空列表，`add_library` 因没有源文件而报错。这是**顺序问题不是配置问题**——先 `xl build . -t cpp`（或让会话走完 `xl_context` → `xl_emit`），再 configure；`CONFIGURE_DEPENDS` 会在后续新增产物时自动重新展开。
* 需要多个库目标（例如「模块级声明」一个、每个类型一个）时，就多写几个 `add_library`，`GLOB` 表达式按目录或文件名收窄即可。

### 11.2 配置与构建：只准在 `<out>/cpp/` 内

```console
$ xl build . -t cpp                    # 先生成产物，dist/cpp 才有 .h/.cpp
$ cd dist/cpp                          # 进入生成树
$ cmake -B build && cmake --build build
```

* **总是 `-B build`**（相对当前目录），构建树恒为 `<out>/cpp/build/`。
* **绝不要**在仓库根或 `<out>/cpp/` 之外跑 cmake——`cmake .`、`cmake -S <repo> -B <repo>` 都会把构建树放到生成树之外，那正是要避免的。
* 构建文件与产物**同处一棵树**时有个额外好处：`#include "…"` 这类相对路径与构建文件里写的 `CMAKE_CURRENT_SOURCE_DIR` 声明同源，不存在「从哪个目录跑」的分歧。**不要**把 `CMakeLists.txt` 放到仓库根或其它目录（`xl` 只管 `<out>/<lang>/`，树外的文件不在任何约定之内）。
* 判据（比人眼可靠）：在仓库根跑 `git status --porcelain`，**输出应当为空**。有输出就说明有东西漏到 `dist/` 之外了（前提是 `dist/` 已 gitignore，见 §11.3）。

### 11.3 不要提交生成树，也不要提交构建树

* 仓库根加 `/dist/`（连同 `/node_modules/` 之类）；构建文件若希望随仓库走，就在生成树里单独放行：根忽略 `dist/`，再加 `!dist/cpp/CMakeLists.txt`。
* 提交 `CMakeCache.txt` 会把**你这台机器的绝对路径与工具链探测结果**一起写进历史，还会让下一次 cmake 复用错误配置。
* 单纯 gitignore 而不真正隔离，等于把污染藏起来——判据仍然是 §11.2 的 `git status` 为空。

### 11.4 这些文件属于谁：常驻、不归 `xl` 管

| 文件 / 目录 | 谁写 | `xl build` 会不会动它 | 归不归 `xl` 管 |
| --- | --- | --- | --- |
| `dist/cpp/pkg/*.h`、`*.cpp` | 你（经 `xl_emit`） | 会（这就是它的计划产物，`--clean` 会删、`--force` 会覆盖） | 是 |
| `dist/cpp/CMakeLists.txt` | 你（手写或会话里生成一次） | **不会**：它不在 `plan.outputs` 里，所以既不覆盖也不删除 | 否（但请留在 `dist/cpp/`，别上交到仓库根） |
| `dist/cpp/build/**`（含 `CMakeCache.txt`、`CMakeFiles/`、`*.o`） | cmake | 不会（`--clean` 只删计划产物，不做目录级删除） | 否 |
| `dist/cpp/.xl/**`（`cache.json` 与历史版本） | `xl` | 会（读 / 写 / 归档） | 是 |

* `xl-cli.md` 的 `E2001` 只保护「`xl` 要写的路径不被非产物文件占用」，**不保护**「`dist/` 之外没被写过」：这条约束靠上面三条约定，不靠 `xl` 校验。真要当门禁，就在 CI 里跑一次 §11.2 的 `git status` 判据。
* **`--clean` 是安全的**：它只对 `plan.outputs` 里的路径做归档 + 删除，不会 `rm -rf dist`，所以 `CMakeLists.txt` 与 `build/` 都不受影响。

---

## 12. 覆盖段与既有实现的优先级

从高到低（四条规则都只决定**取舍与风格**，不能违反 §9 的结构回读）：

1. **`### cpp` / `#### cpp` / `## cpp` 代码块**：作者为 C++ 写的实现，直接采用，只做必要的包装（命名空间、访问级、签名对齐）。类成员用 `### cpp`，访问器用 `#### cpp`，模块级 / `# statement` 用 `## cpp`（语法 §16）。
2. **既有实现**：`xl_cache` / `xl_context` 给出的上一版产物**在它之上改**，不要重写。原样保留既有命名、头文件布局、错误处理风格、命名空间——即使它们和本文不同。
3. **目标仓库的编码规范**（`.clang-format`、`CONTRIBUTING.md`、邻近文件的既有风格）：包括缩进（本文示例用 2 空格）、大括号位置、命名前缀、成员声明顺序、是否允许 `inline` 变量。
4. **本文**：以上都没有时的默认答案。

补充说明：

* 覆盖段与默认 `ts` 块的**关系**：`### cpp` 存在时优先用它，`ts` 块退化成「行为说明」，用来校验覆盖段有没有漏掉分支（例如 `ts` 里有 `else` 而覆盖段没有）。
* 覆盖段只有**说明文字、没有代码块**时（`W3011`）：当作设计意图读，自己写实现。
* 同一个父标题下重复的 `## cpp` / `### cpp` 只保留第一个（`E1303`），其余在 IR 里已经被丢弃，不需要考虑。
* `# class` / `# interface` **没有类级语言段**（`## cpp` 会被当成成员而报 `E1201`）：类级的语言说明写在类标题下的散文里，或者就按本文处理。

---

## 13. 常见错误

| 现象 | 后果 | 正确做法 |
| --- | --- | --- |
| 把 `ts` 默认代码块逐字抄进 `.cpp` | 不编译 | 它只是行为说明，必须译成 C++（§12） |
| 模板成员的定义放进 `.cpp` | 链接失败 | 模板定义留在 `.h`（§4.1） |
| 成员名只写成 `x_`，`.h` 里没有 `x` / `set_x` | `E4002` 结构回读失败 | 读写器用不带后缀的名字（§9） |
| 漏交 `.cpp`（或漏交 `.h`） | `E4002`，且一个文件都不写 | 按 `xl_context` 的部件清单逐一交（§1、§9） |
| 自己拼输出路径 | `E2001`（计划外路径） | 逐字用 `xl_context` 给出的路径（§1） |
| 头文件里没有 include guard 或多个 `.cpp` 重复定义常量 | 多重定义 / 覆盖 | guard + `inline constexpr` / `inline const`（§5.2） |
| 接口没有虚析构 | 多态删除是 UB | `virtual ~X() = default;`（§6） |
| `enum class` 的成员与显式值撞车 | 语义含混 | 给冲突成员显式值并注释（§5.2） |
| 用 `""` 或 `0` 表示「未提供」 | 语义丢失 | `std::optional<T>` + `std::nullopt`（§4.3） |
| 目标代码里出现裸 `new` / 裸指针所有权 | 泄漏、评审不过 | `std::unique_ptr` / `std::shared_ptr` / 值语义 |
| `# statement` 依赖其它 TU 的全局对象初始化顺序 | 静态初始化顺序问题 | 改成函数内 `static` 或显式初始化入口（§5.6） |
| 伪造宿主语言才有的能力（`fetch`…） | 运行时静默错误 | 明确失败或向调用方说明（§5.5） |
| 在产物里写 `@generated` 头 / 时间戳 | 与 `xl_emit` 追加的头冲突、破坏可复现性 | 只交纯代码，头交给 `xl_emit`（§1） |
| 把 `CMakeLists.txt` 放在仓库根 | 仓库根被污染；xl 的布局约定（`<out>/<lang>/`）只覆盖生成树 | 放 `<out>/cpp/CMakeLists.txt`（§11.1） |
| 从仓库根跑 `cmake .` / `cmake -S . -B <repo>` | 仓库根长出 `CMakeCache.txt`、`CMakeFiles/`、`Makefile`/`build.ninja`；`CMakeCache.txt` 里写满本机绝对路径，还会让后续 cmake 复用错误配置 | `cd dist/cpp && cmake -B build`（§11.2） |
| 构建树没 gitignore，或 gitignore 了却没真隔离 | 生成树 / 构建树被提交，`git status` 一片红 | `.gitignore` 忽略 `/dist/` + 用 `git status --porcelain` 当判据（§11.2、§11.3） |
| `GLOB` 把 `.xl/` 里的历史版本归档一起收进构建 | 同一个符号定义两次，链接期重复定义 | `list(FILTER … EXCLUDE REGEX "/\\.xl/")`（§11.1） |
| 产物还没生成就先 configure | `add_library` 收到空源列表而报错（顺序问题） | 先 `xl build . -t cpp` 或走完 `xl_context` → `xl_emit`（§11.1） |

---

## 14. 与 ts 直出的对照（速查）

| 构念 | ts 直出（`xl-emit-ts.md`） | C++（本文） |
| --- | --- | --- |
| 通道 | 离线、确定性、字节契约 | 计划通道，agent 生成，只强制结构回读 |
| 一个源 → 几个文件 | 1（`layout=file`） | N（`layout=type`：每类型一份 + `_module`）；`.cpp` 按 `requires: "bodies"` 可选 |
| `# namespace` | **不进产物**（ts 的模块边界是文件） | 映射为 `namespace <name> { … }` |
| 模块级声明 | 各自 `export`，同文件 | 合并进 `<基名>_module.{h,cpp}` |
| `property` | 展开成 `#label` + `get` / `set` | 展开成 `label_` + `label()` / `set_label()` |
| 字段 `?` | `note?: string` | `std::optional<std::string>` |
| `readonly` | `readonly` 修饰符 | 只给 const 读方法（无 setter）/ `constexpr` |
| `yield` | `Generator<T>` + `*` | `std::generator<T>`（C++23）或惰性序列替代 |
| `async` | `Promise<T>` | `std::future<T>`（或目标仓库的协程类型） |
| `# type` 右侧 | 逐字保留 | 按意图选 `using` / `enum class` / `struct`（§5.2） |
| `# statement` | 成为产物里的一个段落 | 匿名初始化对象（§5.6） |
| 说明散文 | 不进产物 | 不进产物（可选写成 `//` 注释，§2.1 规则 6） |
| 构建文件与编译 | 不需要（ts 由 `tsc` / 运行时直接吃） | `<out>/cpp/CMakeLists.txt` 由生成者写；构建树只准在 `<out>/cpp/build/`（§11） |
| `#include` 路径 | 不适用 | 相对 `<out>/cpp/` 的产物路径，**与命名空间无关**（§3.1） |

---

## 15. 一页速记

```text
1  路径逐字用 xl_context；.h 必交，.cpp 只在计划里有它时才交
2  #ifndef guard + namespace <name> {}；.cpp 先 include 自己的头
3  int→int32_t  float/double/number→double  bool→bool  string→std::string
   Array<T>→std::vector<T>  Map<K,V>→std::map<K,V>  Set<T>→std::set<T>
   T?→std::optional<T>  Promise<T>→std::future<T>  Generator<T>→std::generator<T>
   A|B（非 undefined）→std::variant<A,B>
4  #type→按意图选 using / enum class / struct
   #const→inline constexpr（字面量）| inline const（要构造）
   #enum→enum class + 显式底层类型
5  #interface→抽象基类 + virtual ~ = default + 纯虚（只有 .h）
6  #class→template → : public 基类 → , public 接口；接口成员加 override
7  field→private x_ + x()/set_x()（readonly 无 setter；private 无读写器）
   property→后备字段（有初值 / 无 get / 生成器 getter）+ label()/set_label()
   method→成员函数（只读的标 const；会改状态的才不标；static 用 static）
   constructor→成员初始化列表；默认实参只写 .h
8  模板成员定义留在 .h；.cpp 里写非模板成员的类外定义
9  #statement→匿名初始化对象；多段按源顺序，跨 TU 顺序不做保证
10 提交前先 xl_verify：.h 提到每个成员名、参数个数一致、只交计划内的路径
11 构建文件 <out>/cpp/CMakeLists.txt 由你写（xl 不计划、不校验、不删）；
   include 路径相对 <out>/cpp/；构建只准 cd dist/cpp && cmake -B build；
   仓库根不许出现 CMakeLists.txt / CMakeCache.txt / CMakeFiles/；/dist/ 进 .gitignore
```
