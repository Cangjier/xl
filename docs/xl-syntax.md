# xl-md 语法速查

> 源文件是 `*.xl.md`，UTF-8 无 BOM，LF。
> 产物映射见 [`xl-emit-ts.md`](./xl-emit-ts.md)；命令行见 [`xl-cli.md`](./xl-cli.md)；诊断码见 [`xl-check.md`](./xl-check.md)；完整输入与逐字节期望产物见 [`xl-base-case.md`](./xl-base-case.md)。
> 本文描述的是**本实现**的语法；括号里的码是 [`xl-check.md`](./xl-check.md) 的规则码。

## 0. 文档骨架

```text
# dependencies        ← 必须第一个，至多一次
# namespace <name>    ← 可选，至多一次；惯例上紧接 # dependencies
…任意个模块级声明（type / const / method）…
…任意个类型声明（enum / interface / class）…
…任意个 # statement…
```

- 段落顺序：模块级声明（`type` / `const` / `method`）必须排在类型声明（`enum` / `interface` / `class`）之前，否则报 `E1005`。
- `# namespace` **至多一次**（第二次报 `E1005`）；实现不检查它的位置，`# dependencies` 之后任意位置都接受。
- `# statement` 不参与上述顺序：它既不触发也不重置 `E1005`，可以出现在文件任意位置（§17）。

## 1. 通用规则

| 项 | 写法 |
| --- | --- |
| 标题 | 只认 `#` 的个数，不认缩进；章节正文写在标题与下一个标题之间 |
| 语言子标题 | 父标题 level + 1；名字任意标识符 |
| 代码块 | ```` ```<lang> ```` 起、```` ``` ```` 止；`<lang>` 与语言子标题同名 |
| 代码块缩进 | 不缩进；一个段落 / 成员至多一个默认语言（`ts`）块（`# dependencies` 例外，允许重复） |
| 说明散文 | 任意 Markdown 正文，作为该段落/成员的生成上下文，作为产出代码注释 |

## 2. 关键字

下表兼作索引：「含义」是速查释义，完整规则与示例见「详见」所指章节。

| 关键字 | 含义 | 详见 |
| --- | --- | --- |
| `dependencies` | 跨文件引用节 | §4 |
| `namespace` | 包名 | §5 |
| `type` | 类型别名，等号右侧是原文 | §6 |
| `const` | 常量 | §7 |
| `method` | 函数；模块级用 `#`，类成员用 `##` | §8 |
| `enum` | 枚举 | §9 |
| `interface` | 接口 | §10 |
| `class` | 类 | §11 |
| `statement` | 顶层语句：模块加载时执行一次 | §17 |
| `field` | 字段 | §12 |
| `property` | 属性 | §13 |
| `constructor` | 构造器 | §15 |
| `get` | 属性的读访问器 | §14 |
| `set` | 属性的写访问器 | §14 |
| `case` | enum 成员，写成列表项 | §9 |
| `public` | 可见性修饰符：公开 | §3 |
| `protected` | 可见性修饰符：受保护 | §3 |
| `private` | 可见性修饰符：私有 | §3 |
| `static` | 修饰符：静态；可修饰 `class` 与类成员 | §8、§12–§15 |
| `readonly` | 修饰符：只读；只修饰字段 | §12 |
| `extends` | 继承基类、继承接口，或泛型参数约束 | §10、§11 |
| `implements` | 类实现接口，可多个 | §11 |
| `async` | 异步成员 | §8 |
| `yield` | 生成器成员，写在默认语言代码块体内 | §8 |
| `import` / `from` | 跨文件引用 | §4 |

## 3. `public` / `protected` / `private`

三个可见性修饰符互斥，至多写一个；位置在声明的 `#` 之后、声明关键字之前。

| 可加在 | 模板 |
| --- | --- |
| 一级声明 | `# [modifiers] type` / `const` / `enum` / `interface` / `class` … |
| 模块级函数 | `# [modifiers] method <name>:<T>(<参数>)=><返回类型>` |
| 类 / 接口成员 | `## [modifiers] field` / `property` / `method` / `constructor` … |
| 属性访问器 | `### [modifiers] get` / `### [modifiers] set` |

````md
# private class helper

## private field raw:int = 0

## private property label:string
### get
### private set

## private static method clamp:(v:int)=>int
````

- 与 `static` / `readonly` 叠加时顺序任意。
- 默认为 `public`。
- `# statement`（§17）不接受任何修饰符：写上 `public` / `protected` / `private` / `static` / `readonly` 报 `E1202`。
- `protected` 在一级声明（含模块级 `# method`）上非法，报 `E1202`；类成员与类成员访问器上合法。
- interface 的成员只描述签名：写在上面的 `private` / `protected` / `static` / `readonly` **不报错**，也只对 `## field` 的 `readonly` 有实际意义（`xl-emit-ts.md` §6.2）。
- 同一个标题里写两个可见性（如 `## public private field x:int = 0`）报 `E1211`。

## 4. `# dependencies`

````md
# dependencies
```xl
import { level } from "./util.xl.md"
```

```ts
import _ from "lodash";
import { readFileSync as rf } from "node:fs";
```
## csharp
```csharp
using System.Text.Json;
```
````

- ```` ```xl ```` 块：跨文件引用，每行 `import { … } from "<相对路径>.xl.md"`。
- 默认语言（`ts`）块：进 ts 产物；`## <lang>` 下的块只作说明。
- `## <lang>` 与默认语言块之间不要求空行。

## 5. `# namespace`

````md
# namespace demo
demo 包的用途说明，会成为 LLM 生成的上下文。
````

## 6. `# type`

````md
# type MemberKind = "field" | "property" | "method"
成员种类。
````

- 等号右侧是**原文**，不参与 xl 本体的类型解析。

## 7. `# const`

有初始值：

````md
# const MAX_DEPTH:int = 8
默认代码块深度上限。
````

初始值写不进一行时，用默认语言代码块给出：

````md
# const RULES:ReadonlyArray<string>
规则码清单；初始值用默认语言代码块给出。
```ts
[
  "E1001",
  "E1002",
]
```
````

## 8. `method`

模板：`#/## [modifiers] method <name>:<T>(<参数>)=><返回类型>`

````md
# method loadText:(path:string, encoding?:string)=>string
同步读取文本；
```ts
return rf(path, encoding ?? "utf8");
```
````

````md
# method pickFirst:<T>(items:Array<T>)=>T
取第一个元素
```ts
return items[0]!;
```
````

- 泛型 `:<T>` 写在成员名之后、参数表之前。
- `async` 写在冒号之后：`# method load:async (url:string)=>string`。
- 参数可选写 `name?:Type`。
- 可见性修饰符见 §3，写在 `method` 之前；类成员还可叠加 `static`。
- 函数体一律用默认语言代码块；体内出现 `yield` 时按生成器直译。

## 9. `# enum`

````md
# enum color
可见颜色
- case red
红色
- case green = 2
绿色
- case blue
蓝色

## python
使用字符串表达
````

- 成员是**列表项** `- case <name>`；以 `-` 开头但不合该形态的行报 `E1212`，一个 `- case` 都没有报 `E1109`。
- `- case green = 2` 的等号右侧是**原文**，按目标语言直译。
- `## <lang>` 是该 enum 的语言实现说明。

## 10. `# interface`

````md
# interface printable

## readonly field kind:"printable"

## readonly field id:string

## field note?:string

## method print:()=>string
````

````md
# interface named extends printable

## field tag:string

## method describe:()=>string
````

- 成员只能是 `## field` 与 `## method`；写 `## property` / `## constructor` 报 `E1102`。
- 成员只声明，不带函数体（带体报 `E1304`）、不带初始值（带初始值报 `E1102`）。
- `## field <name>?:<Type>` 的 `?` 表示可选。
- `# interface` **不接受泛型参数**（`# interface a<T>` 报 `E1103`），也不接受 `implements`（报 `E1102`）；`extends` 只能指向另一个 interface，指向 class 或未知名字是 warning `E1105`。
- class 用 `implements` 声明实现某个 interface：成员名或参数个数对不上是 warning `E1105`。

## 11. `# class` 头部

````md
# class point
````

````md
# class box<T extends object> extends point implements printable
````

````md
# class cache<K extends string, V = any>
````

- 顺序固定：`# [modifiers] class <name><<T,…>> extends <Base> implements <Iface,…>`，三段都可省。
- 类名之前可写可见性修饰符（见 §3）。

## 12. `field`

模板：`## [modifiers] field <name>:<Type> = <初始值>`

````md
## field x:int = 0
横坐标。
````

````md
## field data:Map<K,V>
```ts
new Map()
```
````

````md
## static readonly field ORIGIN:string = "0,0"
````

- 初始值一行能写完就内联 `= <expr>`，否则改用默认语言代码块。
- 可选字段写 `## field <name>?:<Type>`。
- 标题下的说明散文是该成员的生成上下文，并作为产出代码的注释。

## 13. `property`

模板：`## [modifiers] property <name>:<Type> = <初始值>`（`= <初始值>` 段可省）

````md
## property label:string = "unnamed"
### get
### private set
````

- 与 `field` 的差别：`property` 可以挂 `### get` / `### set` 访问器（见 §14）。
- 初始值一行能写完就内联 `= <expr>`，否则改用默认语言代码块。
- 成员名后写 `?`（`## property label?:string`）是**无效的**：xl 接受它但把 `?` 丢掉，可选性由访问器语义表达（`xl-emit-ts.md` §8）。
- 一个 `property` 至少要挂一个访问器，否则报 `E1209`；把它当普通字段用请改写成 `## field`。

## 14. property 访问器

````md
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

- 模板：`### [modifiers] get` / `### [modifiers] set`，例 `### private set`。
- 可见性修饰符见 §3，写在 `get` / `set` 之前。
- 访问器可以只有标题、没有代码块（如 §13 的 `label`）。
- 访问器下可再挂语言子标题 `#### <lang>`。
- 顺序固定 `get` 在 `set` 之前（写反报 `E1210`），每种至多一个（重复报 `E1210`）。
- 写在非 `property` 成员下（如 `## method m:()=>void` 之后的 `### get`）报 `E1209`；`###` 下的第三个名字既不是 `get` / `set` 也不是语言名时报 `E1305`。

## 15. `constructor`

模板：`## [modifiers] constructor:(<参数>)=>void`

````md
## constructor:(x?:int, y?:int)=>void
```ts
this.x = x ?? 0;
this.y = y ?? 0;
```
````

- `constructor` 没有成员名，返回类型固定 `void`。
- 可见性修饰符见 §3，写在 `constructor` 之前。
- 函数体一律用默认语言代码块。

## 16. 语言子标题

| 所在父标题 | 子标题 |
| --- | --- |
| `# dependencies` / `# namespace` / `# type` / `# const` / `# method` / `# enum` / `# statement` | `## <lang>` |
| `## field` / `## property` / `## method` / `## constructor` | `### <lang>` |
| `### get` / `### set` | `#### <lang>` |

- 名字是任意标识符；与代码块围栏标记同名。
- 子标题下的内容与该父级同构（可含代码块与正文），只作说明，不进默认语言产物。
- `# class` 与 `# interface` **没有类级语言段**：它们下面的 `## …` 一律按成员标题解析，所以 `## csharp` 会报 `E1201`（未知成员种类）。类级的语言说明写在类标题下的散文里，成员的覆盖段用 `### <lang>`。
- 子标题名不认识时（既不是语言名，也没有同名的代码块围栏）报 `E1305`；同一个父标题下同名语言段出现两次报 `E1303`，**只保留第一个**，其余丢弃。

````md
## method load:async (url:string)=>string
异步读取。
```ts
const r = await fetch(url);
return r.text();
```

### csharp
```csharp
using var http = new HttpClient();
return await http.GetStringAsync(url);
```
````

## 17. `# statement`

模块级可执行语句：文件被加载时按源文件顺序执行。

````md
# method Main:(args:Array<string>)=>void
```ts
…
```

# statement
进程入口：模块被 import 时执行一次。
```ts
Main(process.argv.slice(2));
```

## csharp
```csharp
Main(args);
```
````

- 模板：`# statement`，**不带名字**，也不接受任何修饰符——写修饰符报 `E1202`，多写一个词报 `E1203`。
- 正文取该段的默认语言（`ts`）代码块，与 `# method` 同规则：一个段至多一个默认语言块（多个报 `E1301`），语言覆盖段用 `## <lang>`（§16）。
- 允许出现多次，也可以出现在文件的任意位置；执行顺序＝源文件出现顺序。
  xl **不做顺序检查**：语句引用同文件中后置的 `# const` / `# class` 时的 TDZ 风险由作者承担。
- 语句不声明名字：不进产物的 `export` 清单，也不能被 `# dependencies` 的 `import { … }` 引用（§4）。
- 说明散文与 `## <lang>` 段是其它目标的生成依据，不进 ts 产物（§1、§16）。
- 既没有非空的默认语言块、也没有任何带代码块的 `## <lang>` 段时是错误（`xl-check.md` 的 `E1110`）：这个段没有任何生成依据。
- 默认语言块里写静态顶层 `import`（或带 `from` 的 `export`）是提示（`xl-check.md` 的 `W3013`）：它会被提升到产物头之前；依赖一律写进 `# dependencies`（§4）。
