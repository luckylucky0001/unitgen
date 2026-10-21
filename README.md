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
   → mutate（变异测试：改被测代码已覆盖的行，看断言能否发现，衡量测试强度）
   → report
```

## 开源方案调研（2026-10-21，GitHub API 数据）

结论：**没有一个开源工具能同时可靠地覆盖 iOS + Android + 鸿蒙；鸿蒙 ArkTS 方向没有找到任何开源的单测生成工具。**

| 工具 | 平台 | 方法 | 运行测试并量覆盖率 | 状态 | 结论 |
|---|---|---|---|---|---|
| qodo-cover（原 cover-agent） | 理论上任意语言（需 Cobertura/JaCoCo 报告） | LLM：生成→运行→覆盖率门禁 | 是 | 5.7k★，AGPL-3.0，README 声明 2025-06 起**不再维护** | 设计最值得借鉴；AGPL + 停更，不宜直接依赖 |
| EvoSuite | 仅 Java 字节码 | 遗传算法 | 是（含变异分） | 921★，LGPL，最后推送 2025-02 | 偏研究，Kotlin/Android 支持未验证 |
| Randoop | Java | 反馈导向随机测试 | 运行，无覆盖率门禁 | 599★，MIT，活跃 | 生成的回归测试可读性差 |
| UnitTestBot (UTBotJava) | Java | 符号执行 + 模糊测试 | 是 | 147★，Apache-2.0，活跃度低 | 仅 JVM |
| ChatUniTest | Java (Maven) | LLM 生成 + 修复 | 编译运行修复；覆盖率门禁未证实 | 学术项目 | 不适合 Gradle/Android |
| Diffblue Cover | Java/Kotlin | 强化学习 | 是 | 商业闭源 | 仅供参考 |
| Meta TestGen-LLM / ACH | Android Kotlin（Meta 内部） | 变异引导的 LLM 生成 | 内部 | 只有论文（arXiv 2501.12862） | 关键设计来源：ACH 在 10,795 个类上生成 571 个测试，工程师接受 73% |
| XCTestGen / SwiftTestGen | Swift | 单次调用 LLM | 否 | 14★/4★，已废弃或不成熟 | 玩具级 |
| 鸿蒙 ArkTS | — | 只找到评测集（ArkEval、ArkRepoBench），没有生成工具 | — | — | DevEco CodeGenie 闭源 |

unitgen 采用的就是调研结论推荐的路线：平台无关的 LLM 闭环 + 每个平台一个适配器，并吸收了关键设计：
1. 生成→编译→运行→覆盖率的闭环，错误回喂修复（qodo-cover / TestGen-LLM）；
2. 严格过滤：可编译、全部通过、多次重跑不 flaky、覆盖率上升才保留；
3. 变异测试作为比覆盖率更强的判据（ACH）；
4. 丰富上下文：已有测试、项目自带 fake、可用测试库、构建约定。

## 快速开始

```bash
cd ~/Documents/unitgen && npm install        # 只为类型检查和鸿蒙 shim（typescript、c8）
export PATH="$HOME/Documents/unitgen/bin:$PATH"

cd <你的工程>
unitgen doctor        # 识别工程类型、检查工具链
unitgen baseline      # 跑现有测试 + 覆盖率（一次）
unitgen targets       # 看最该补的文件
unitgen brief <源文件>               # 生成该文件的 brief
unitgen verify <测试文件>             # --target 可省略，按文件名自动推断
unitgen mutate <测试文件>             # 变异测试，给出没被发现的改动
unitgen reject <测试文件> "原因"       # 放弃并隔离
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

三轮共 7 个独立子代理只读 Skill 完成了大部分目标（标 ★），其余由我按同一流程完成。

| 平台 | 工程 | 目标 | 覆盖率 | 测试数 |
|---|---|---|---|---|
| iOS | nicklockwood/Expression | Expression.swift（1.5k 行解析器） | 0% → 82% | 38 |
| iOS | nicklockwood/Expression ★ | AnyExpression.swift（1.1k 行，Any 类型求值器） | 0% → 99% | 106 |
| iOS | SwiftyJSON ★ | SwiftyJSON.swift | 0% → 97% | 40 |
| Android | android/nowinandroid（34 模块，AGP 9） | NiaPreferencesDataSource | 35% → 91% | 18 |
| Android | android/nowinandroid | DefaultSearchContentsRepository | 0% → 100% | 7 |
| Android | android/nowinandroid ★ | SearchViewModel（SavedStateHandle + Flow） | 75% → 100% | 12 |
| Android | android/nowinandroid ★ | GetSearchContentsUseCase | 0% → 100% | 7 |
| Android | android/nowinandroid ★ | MainActivityViewModel（:app，Hilt 字节码改写） | 0% → 100% | 11 |
| Android | android/architecture-samples | DefaultTaskRepository | 78% → 100% | 7 |
| Android | android/architecture-samples ★ | AddEditTaskViewModel | 82% → 99% | 10 |
| Android | android/architecture-samples ★ | TaskDetailViewModel | 85% → 98% | 6+ |
| 鸿蒙 | LinysBrowser_NEXT | url-ext.ets（手写 Punycode） | 全覆盖 | 8（RFC 3492 向量） |
| 鸿蒙 | LinysBrowser_NEXT ★ | colors.ets（HSV/RGB 转换） | 0% → 100% | 14 |
| 鸿蒙 | LinysBrowser_NEXT ★ | keyshortcuts helpers / meowKeyBind | 0% → 76% / 全覆盖 | 9 / 8 |
| 鸿蒙 | JhHarmonyDemo ★ | UserModel / APIs | 0% → 100% | 8 |
| 鸿蒙 | interview-handbook-project ★ | base.ets 等 3 个文件 | 全仓 0% → 6%（估算） | 20 |

**门禁验证**：三端都故意改错断言 → `TEST_FAILURES`（附断言差异）、故意写类型错误 → `COMPILE_ERROR`（附编译器原文）。
**覆盖率口径**：SwiftPM 的逐行结果与 `llvm-cov export -format=lcov` 完全一致（966/1179）。

**变异测试**（`unitgen mutate`）：

| 测试 | 得分 | 说明 |
|---|---|---|
| Expression.swift | 100%（9/9） | 1 个变异体编译不过，自动丢弃 |
| url-ext.ets（Punycode） | 92%（11/12） | 唯一幸存者是等价变异（越界读 `undefined` 后走同一分支） |
| colors.ets ★ | 80% → 100% | 两个幸存者都是真漏洞（NaN 色相、非纯色），补测试后全杀 |
| AddEditTaskViewModel ★ | 75% → 100% | 发现「整体比较默认 UiState」的断言永远不会失败（变异后默认值也跟着变） |
| TaskDetailViewModel ★ | 90% → 100% | |
| DefaultTaskRepository | 67% → **100%** | 揪出 `deleteAllTasks` 的测试其实什么都没验证（删掉 `deleteAll()` 也通过）；补一条断言后全杀。**覆盖率没变，只有变异测试能发现这种弱测试** |

**发现的疑似 bug**（测试按现行为断言并标注 `UNITGEN-SUSPECT`，均已对照源码确认或有可复现证据）：
- SwiftyJSON：两个 bool 的 `<=` / `>=` 退化为相等比较（`JSON(true) >= JSON(false)` 为 false）。
- Expression：`AnyExpression("true + 1")` 得 2（Bool 桥接成 NSNumber 落入数值加法；源码里也有 TODO 质疑）。
- JhHarmonyDemo：`JhPreferencesUtils` 的 bool/number/model 方法调用了 `JhAESPreferencesUtils.saveString/getString`，疑似复制粘贴错误。
- interview-handbook：`getPercentText` 未处理 `total === 0`，返回 `'Infinity%'` / `'NaN%'`。
- LinysBrowser：`isFn('foo')` 返回 true（只判断长度 > 1 且以 F 开头）。

**迭代过程**：每轮试用的子代理都把 CLI/Skill 的问题按「最重要」列出，共修复约 60 处，例如 SwiftPM `Source/` 目录、Gradle `--tests` 绑定到错误任务、Hilt 改写字节码导致 JaCoCo 丢数据、`src/testDemo` 测试源集、鸿蒙三方包被误桩、iOS 同 target 测试互相串覆盖率、报告中的重复/截断等。

## 已知限制

- iOS：只支持 SwiftPM 包；纯 Xcode 工程（xcodeproj + 模拟器）尚未实现。只有 Command Line Tools 时 XCTest 不可用，已有 XCTest 用例跑不了（baseline 为 0%），只能用 Swift Testing。
- Android：只覆盖 JVM 本地单测（src/test）；`android.util.Log` 等在没有 Robolectric / `isReturnDefaultValues` 时会抛异常，相应分支不会被覆盖。
- 鸿蒙：没有 hvigor 时的 shim 只对纯逻辑可信；`@kit.*`/`@ohos.*` 系统 API、ArkUI 全局量/装饰器、UI 组件（struct）文件都是空桩；未安装的 ohpm 包、shim 解析不了的语法、缺失的全局量都报 `INFRA_ERROR`（不会被当成测试错误）。shim 下的覆盖率在 switch/case 上可能偏高（V8 块覆盖 + source map 的局限）。ArkTS lint 只覆盖常见限制，最终仍需在 DevEco/hvigor 跑一遍。hvigor 原生路径已实现但未在真机工具链上验证。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test（解析器、门禁相关单测）
```

调试：`UNITGEN_VERBOSE=1` 打印执行的命令；`UNITGEN_KEEP_COV=1` 保留 SwiftPM 的覆盖率 JSON。

安全性：`mutate` 临时改被测源码，写日志 `.unitgen/mutation-in-progress.json`，任何 unitgen 命令启动时都会自动还原（已验证：运行中直接杀掉进程，下次启动即还原）；iOS 隔离验证时临时挪开的同 target 测试文件同理。
