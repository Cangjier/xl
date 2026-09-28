# dependencies
```ts
import { inspect } from "node:util";
```

# method describe:(value:level)=>string
把级别渲染成短标签，供日志行使用。
```ts
return inspect(value);
```

## csharp
```csharp
return value.ToString();
```

# enum level
日志级别。

- case debug = 10
调试。
- case info = 20
信息。
- case warn = 30
警告。
- case error = 40
错误。

## csharp
```csharp
public enum Level { Debug = 10, Info = 20, Warn = 30, Error = 40 }
```
