# unitgen

面向 **iOS（Swift）/ Android（Kotlin/Java）/ 鸿蒙（ArkTS）** 的「覆盖率驱动」单元测试补全工具：CLI + Claude Code Skill。

思路借鉴 Meta TestGen-LLM 与 Qodo Cover-Agent：**生成不是难点，筛选才是**。模型（或 Claude Code 本身）负责写测试，unitgen 负责决定测什么、并且只保留真正有价值的测试：

```
baseline（跑现有测试 + 覆盖率）
   → targets（按「未覆盖逻辑行」排序）
   → brief（给模型的上下文：源码+未覆盖行标记、约定、可用测试库、项目自己的 fake、同类已有测试）
   → 写测试
   → verify（编译 → 全部通过 → 重跑防 flaky → 有断言 → 新增覆盖行 > 0）
   → 失败把编译/断言信息回喂，重试；放弃则隔离到 .unitgen/rejected
   → report
```

## 快速开始

```bash
cd ~/Documents/unitgen && npm install        # 只为类型检查和鸿蒙 shim（typescript、c8）
export PATH="$HOME/Documents/unitgen/bin:$PATH"

cd <你的工程>
unitgen doctor        # 识别工程类型、检查工具链
unitgen baseline      # 跑现有测试 + 覆盖率（一次）
unitgen targets       # 看最该补的文件
unitgen brief <源文件>               # 生成该文件的 brief
unitgen verify <测试文件> --target <源文件>
unitgen report        # .unitgen/REPORT.md
```

需要 Node ≥ 22.18（直接运行 TypeScript 源码，无构建步骤）。

### 作为 Claude Code Skill 使用

```bash
mkdir -p ~/.claude/skills && ln -s ~/Documents/unitgen/skills/unitgen ~/.claude/skills/unitgen
```

然后在 Claude Code 里说「给这个工程补单测」即可；Skill 规定了完整流程、各 verdict 的处理方式和硬性规则（不改产品代码、不弱化断言等）。

### 无人值守模式

```bash
unitgen generate --llm anthropic --limit 5        # 需要 ANTHROPIC_API_KEY
unitgen generate --llm claude --limit 5           # 需要 claude CLI
unitgen generate --llm 'cmd:<任意读 stdin 输出代码的命令>'
```

## 三端实现

| | 识别 | 运行与覆盖率 | 生成测试位置 |
|---|---|---|---|
| iOS | `Package.swift` | `swift test --enable-code-coverage`，解析 llvm-cov 导出（与 `llvm-cov export -format=lcov` 逐行一致） | 独立 test target `<Target>UnitGenTests`（Package.swift 末尾带标记的块） |
| Android | `settings.gradle(.kts)` | 自动发现每个模块的单测任务（含 flavor），`-I` 注入 JaCoCo init script，**不改任何构建文件**；兼容 configuration cache / isolated projects | `src/test/<kotlin|java>/<包路径>/<类>UnitGenTest.kt`，`--tests` 只跑这一个类，`--rerun` 防缓存 |
| 鸿蒙 | `build-profile.json5` | 有 hvigor 用 hvigor；否则 Node shim：TS 转译 .ets + hypium 兼容实现 + c8 覆盖率（映射回 .ets 行）+ ArkTS 语法限制 lint | `<module>/src/test/<文件>.unitgen.test.ets`，自动登记到 `List.test.ets` |

## 验证结果（2026-10-21，本机：macOS + Command Line Tools，无 Xcode / DevEco）

| 平台 | 工程 | 目标文件 | 覆盖率 | 测试数 |
|---|---|---|---|---|
| iOS | nicklockwood/Expression | Expression.swift（1.5k 行解析器） | 0% → 82% | 38 |
| iOS | SwiftyJSON（独立子代理按 Skill 完成） | SwiftyJSON.swift | 0% → 97.1% | 40 |
| Android | android/nowinandroid（34 模块，AGP 9） | NiaPreferencesDataSource | 35% → 91% | 18 |
| Android | android/nowinandroid | DefaultSearchContentsRepository | 0% → 100% | 7 |
| Android | android/architecture-samples | DefaultTaskRepository | 78% → 100% | 6 |
| 鸿蒙 | LinysBrowser_NEXT | url-ext.ets（手写 Punycode） | 0% → 全覆盖 | 8（RFC 3492 向量） |
| 鸿蒙 | JhHarmonyDemo（独立子代理） | UserModel / APIs | 0% → 100% | 8 |

门禁本身也做了「变异」验证：故意改错断言 → `TEST_FAILURES` 并给出差异；故意写类型错误 → `COMPILE_ERROR` 并给出编译器原文；三端均如此。

发现的疑似 bug（测试按现行为断言并标注 `UNITGEN-SUSPECT`）：
- SwiftyJSON：两个 bool 的 `<=` / `>=` 退化为相等比较（`JSON(true) >= JSON(false)` 为 false）。
- JhHarmonyDemo：`JhPreferencesUtils` 的 bool/number/model 方法调用了 `JhAESPreferencesUtils.saveString/getString`，疑似复制粘贴错误。

## 已知限制

- iOS：只支持 SwiftPM 包；纯 Xcode 工程（xcodeproj + 模拟器）尚未实现。只有 Command Line Tools 时 XCTest 不可用，已有 XCTest 用例跑不了（baseline 为 0%），只能用 Swift Testing。
- Android：只覆盖 JVM 本地单测（src/test）；`android.util.Log` 等在没有 Robolectric / `isReturnDefaultValues` 时会抛异常，相应分支不会被覆盖。
- 鸿蒙：没有 hvigor 时的 shim 只对纯逻辑可信；`@kit.*`/`@ohos.*` 系统 API 与 ArkUI 全局量是空桩；未安装的 ohpm 包直接报 `INFRA_ERROR`（需要 `ohpm install`）。ArkTS lint 只覆盖常见限制，最终仍需在 DevEco/hvigor 跑一遍。hvigor 原生路径已实现但未在真机工具链上验证。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test（解析器、门禁相关单测）
```

调试：`UNITGEN_VERBOSE=1` 打印执行的命令；`UNITGEN_KEEP_COV=1` 保留 SwiftPM 的覆盖率 JSON。
