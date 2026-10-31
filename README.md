# unitgen

面向 **iOS（Swift）/ Android（Kotlin/Java）/ 鸿蒙（ArkTS）** 的「覆盖率驱动」单元测试补全工具：CLI + Agent Skill（Claude Code / TRAE）。

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

## 在一台新电脑上安装

前置条件（只装你要用的平台对应的那部分）：

| 用途 | 需要 |
|---|---|
| CLI 本身 | Node.js ≥ 22.18（`node -v` 检查）；PATH 里没有合适的 Node 时自动使用 DevEco Studio 自带的 Node |
| Android | JDK 17+（`JAVA_HOME`）、Android SDK（`ANDROID_HOME` 或工程里的 `local.properties`） |
| iOS | Xcode（SwiftPM 包和 .xcodeproj 工程，后者在 iOS 模拟器上跑）；只有 Command Line Tools 时只能跑 Swift Package + Swift Testing |
| 鸿蒙 | 推荐安装 DevEco Studio（自动发现，用真实 hvigor + ArkTS 编译器 + Previewer 运行时，不需要模拟器）；工程需在 devDependencies 里声明 `@ohos/hypium`（≥ 1.0.19 才能在 Previewer 里拿到覆盖率）并执行过 `ohpm install`。没有 DevEco 时用内置的 Node shim 跑纯逻辑 |

```bash
git clone https://github.com/luckylucky0001/unitgen.git ~/unitgen
cd ~/unitgen && npm install
mkdir -p ~/.local/bin && ln -sfn ~/unitgen/bin/unitgen ~/.local/bin/unitgen
export PATH="$HOME/.local/bin:$PATH"          # 写进 ~/.zshrc 可永久生效
unitgen --help

# 作为 Claude Code Skill（可选）
mkdir -p ~/.claude/skills && ln -sfn ~/unitgen/skills/unitgen ~/.claude/skills/unitgen
```

演示建议：先在一个开源工程上跑 `unitgen doctor` → `baseline` → `targets`，再让 Claude Code 用 Skill 补 1–2 个文件，最后 `unitgen mutate` 和 `unitgen report`。Android 工程第一次构建会下载 Gradle 依赖，建议提前跑一次 `baseline` 预热。

## 快速开始

```bash
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

需要 Node ≥ 22.18（直接运行 TypeScript 源码，无构建步骤）。如果仓库旁边有 `unitgen-env/env.sh`（本机就是），`bin/unitgen` 会自动用里面的 Node 24 / JDK 17 / Android SDK 路径，只对 unitgen 进程生效。

### 作为 Claude Code Skill 使用

```bash
mkdir -p ~/.claude/skills && ln -sfn ~/unitgen/skills/unitgen ~/.claude/skills/unitgen
```

然后在 Claude Code 里说「给这个工程补单测」即可；Skill 规定了完整流程、各 verdict 的处理方式和硬性规则（不改产品代码、不弱化断言等）。

### 在 TRAE / TRAE CN 中使用

TRAE 直接编写测试、调用 unitgen 执行质量检查，这条路径不需要 Claude CLI 或 Anthropic API Key。
安装脚本适用于 macOS/Linux，完整安装 Skill 和相对引用文件（保留此 checkout，不要移动或删除）：

```bash
cd /absolute/path/to/unitgen
npm ci
sh scripts/install-trae.sh --project /absolute/path/to/android-project
# 或安装为 TRAE CN 全局技能：
sh scripts/install-trae.sh --global
```

项目 Skill 位于 `<project>/.trae/skills/unitgen/`，TRAE CN 全局 Skill 位于 `~/.trae-cn/skills/unitgen/`。
脚本也将 CLI 链接到 `~/.local/bin/unitgen`；可用 `UNITGEN_BIN_DIR` 指定其他 bin 目录，不覆盖已有用户文件。
确保 TRAE 工具进程的 PATH 包含此 bin 目录，或明确提供 CLI 的绝对路径。
目录依据：[TRAE 官方 Skill 文档](https://docs.trae.cn/ide_skills)。Windows 请手动复制整个 `skills/unitgen/` 目录到对应 Skill 目录，并使用可运行此 shell 入口的环境；安装脚本未在 Windows 验证。

推荐把本机工具链路径保存在仓库外的环境文件：

```bash
cp scripts/unitgen-env.example.sh /absolute/path/to/unitgen-env.sh
# 编辑文件，填写 Node、JAVA_HOME、ANDROID_HOME（不要提交本机路径或凭证）
UNITGEN_ENV=/absolute/path/to/unitgen-env.sh /absolute/path/to/unitgen/bin/unitgen doctor -C /absolute/path/to/android-project
```

每次 TRAE 工具调用都传 `UNITGEN_ENV`，不要假设上一条命令的 `export` 会跨调用保留。
在 TRAE 中启用/选择 unitgen Skill 后，可以使用下面的任务描述：

> 使用 unitgen 给当前 Android 工程补单测。先 doctor 和 baseline，基线成功后按 targets/brief 选择逻辑文件。读取关联 DTO 和 fake 的实际实现，生成测试，逐个 verify，再 mutate 检查断言强度，最后输出 report。只新增测试，不改产品代码、已有测试和构建文件。报告覆盖率分子分母、变异抽样数及未验证范围。

这是推荐接入流程；已有 Android 实验验证了 TRAE 读取 Skill、生成测试和调用 CLI，不能据此声称已验证所有 TRAE 版本的自动发现/触发行为。

### 自动化结果、进度与停止

- 长时间测试/构建使用异步子进程，构建输出实时写入日志并发送到 stderr；每 30 秒输出运行状态。`UNITGEN_QUIET=1` 只关闭终端进度，仍写日志。
- `--json` 的结果在 stdout，stderr 是进度/诊断。不要把两者合并后当 JSON 解析。管道记录时使用支持 `pipefail` 的 shell，保留 unitgen 的实际退出码。
- 退出码：`0` 通过；`1` 命令/环境/参数错误；`2` 质量门禁失败；`130` 用户取消。
- `baseline` 只跑工程**原有**的测试（unitgen 生成的测试不计入「改造前」）。构建失败、测试失败或覆盖率拿不到时返回非零并标记基线无效，输出里写明原因和失败的用例；`--allow-failing` 可以在列出失败用例的前提下保留基线。没有任何测试的鸿蒙工程直接得到有效的 0% 基线（shim/hvigor 的覆盖率由 unitgen 自己统计，「没跑出东西」不会被误当成 0%）。`verify`、`mutate`、`generate` 要求成功的基线，并且要求和基线用同一个运行器（例如都用 hvigor）。
- `mutate` 默认要求 `--min-score 80`，未达标或变异运行遇到环境错误返回 `2`；没有可生成的变异体明确标记 `NOT_APPLICABLE`（退出 `0`），不把它解释成断言强度 100%。仍须报告抽样数、幸存项和仅由崩溃检出的数量。
- `generate` 在 verify 后执行 mutate，将未通过的变异反馈给模型继续补强；重试耗尽则隔离该文件，并返回 `2`。`--max` 控制每轮变异预算；目前没有原生 `--llm trae`，TRAE 用户优先使用上面的 Skill 流程。
- 一个项目一次只允许一个 CLI 命令，包括读取/恢复命令。超时、SIGINT/SIGTERM 会终止测试的**整棵进程树**：包括自己另开进程组的测试助手（如 `swiftpm-testing-helper`，死循环的变异体曾让它在后台一直涨内存），然后恢复源码、释放锁。Windows 使用 `taskkill /T`，该平台尚未实测。
- 被强杀（SIGKILL、关掉终端、Agent 会话中断）之后不需要手动处理：锁文件记录了监督进程、worker 和所有后代进程（PID + 启动时间），下一条命令会确认它们都已退出，或者自动停掉能确认身份的残留进程，然后接管锁，还原被变异的源码、被临时替换的 `List.test.ets` 和 `Package.swift`。只有仍有无法确认的构建进程在跑时才会提示你，并给出具体的 kill 命令。

Android 的验证范围是 JVM 本地单测；APK 安装、真机 API 和 UI 测试需要另外验证。

### 无人值守模式

```bash
unitgen generate --llm anthropic --limit 5        # 需要 ANTHROPIC_API_KEY
unitgen generate --llm claude --limit 5           # 需要 claude CLI
unitgen generate --llm 'cmd:<任意读 stdin 输出代码的命令>'
```

## 三端实现

| | 识别 | 运行与覆盖率 | 生成测试位置 |
|---|---|---|---|
| iOS（SwiftPM） | `Package.swift` | `swift test --enable-swift-testing --enable-code-coverage`，解析 llvm-cov 导出（与 `llvm-cov export -format=lcov` 逐行一致） | 独立 test target `<Target>UnitGenTests`（Package.swift 末尾带标记的块） |
| iOS（Xcode） | `.xcodeproj` / `.xcworkspace`（两者并存时 `--adapter xcode`） | `xcodebuild test` + iOS 模拟器，`-only-testing` 隔离，`xccov` 读覆盖率 | 现有测试 target 里的 `<类>UnitGenTests.swift`，需要时登记到 project.pbxproj |
| Android | `settings.gradle(.kts)` | 自动发现每个模块的单测任务（含 flavor），`-I` 注入 JaCoCo init script，**不改任何构建文件**；兼容 configuration cache / isolated projects | `src/test/<kotlin|java>/<包路径>/<类>UnitGenTest.kt`，`--tests` 只跑这一个类，`--rerun` 防缓存 |
| 鸿蒙 | `build-profile.json5`（或 git 忽略了它时的 `build-profile.template.json5`） | 默认 hvigor：自动发现 DevEco，按 DevEco 本地测试流程（`isLocalTest`/`unitTestMode`/`buildRoot=.test`）在 Previewer 里跑，真实 ArkTS 编译器；verify/mutate 时把 `List.test.ets` 临时指向被测文件，别处编译不过的旧测试不影响；读 `coverageReport.json`。备选 Node shim：TS 转译 .ets、ArkUI struct/@Builder 挖空、hypium 兼容实现、按 source map 逐段映射 V8 覆盖率、ArkTS 限制 lint | `<module>/src/test/<文件>.unitgen.test.ets`，自动登记到 `List.test.ets` |

ROUND2_PLACEHOLDER

## 第一轮验证结果（2026-10-21，本机：macOS + Command Line Tools，无 Xcode / DevEco）

四轮共 9 个独立子代理只读 Skill 完成了大部分目标（标 ★），其余由我按同一流程完成。

| 平台 | 工程 | 目标 | 覆盖率 | 测试数 |
|---|---|---|---|---|
| iOS | nicklockwood/Expression | Expression.swift（1.5k 行解析器） | 0% → 82% | 38 |
| iOS | nicklockwood/Expression ★ | AnyExpression.swift（1.1k 行，Any 类型求值器） | 0% → 99% | 106 |
| iOS | SwiftyJSON ★ | SwiftyJSON.swift | 0% → 97% | 40 |
| iOS | JohnSundell/Splash ★ | Tokenizer.swift / SwiftGrammar.swift | 0% → 100% / 99% | 12 / 165 |
| Android | android/nowinandroid（34 模块，AGP 9） | NiaPreferencesDataSource | 35% → 91% | 18 |
| Android | android/nowinandroid | DefaultSearchContentsRepository | 0% → 100% | 7 |
| Android | android/nowinandroid ★ | SearchViewModel（SavedStateHandle + Flow） | 75% → 100% | 12 |
| Android | android/nowinandroid ★ | GetSearchContentsUseCase | 0% → 100% | 7 |
| Android | android/nowinandroid ★ | MainActivityViewModel（:app，Hilt 字节码改写） | 0% → 100% | 11 |
| Android | android/nowinandroid ★ | DefaultRecentSearchRepository / SyncUtilities | 0% → 100% / 64% → 76% | 6 / 5 |
| Android | android/architecture-samples | DefaultTaskRepository | 78% → 100% | 7 |
| Android | android/architecture-samples ★ | AddEditTaskViewModel | 82% → 99% | 10 |
| Android | android/architecture-samples ★ | TaskDetailViewModel | 85% → 98% | 6+ |
| 鸿蒙 | LinysBrowser_NEXT | url-ext.ets（手写 Punycode） | 0% → 98% | 8（RFC 3492 向量） |
| 鸿蒙 | LinysBrowser_NEXT ★ | colors.ets（HSV/RGB 转换） | 0% → 100% | 14 |
| 鸿蒙 | LinysBrowser_NEXT ★ | keyshortcuts helpers / meowKeyBind | 0% → 76% / 77% | 9 / 8 |
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
| SwiftGrammar.swift ★ | 93% → 100% | 删掉 `keywordsToAvoid.remove("return")` 原测试发现不了，补 `return call()` 用例后全杀 |
| SyncUtilities ★ | 100% | 1 个幸存者经判断为等价变异（返回值被丢弃），用 `--equivalent` 排除 |
| DefaultTaskRepository | 67% → **100%** | 揪出 `deleteAllTasks` 的测试其实什么都没验证（删掉 `deleteAll()` 也通过）；补一条断言后全杀。**覆盖率没变，只有变异测试能发现这种弱测试** |

**发现的疑似 bug**（测试按现行为断言并标注 `UNITGEN-SUSPECT`，均已对照源码确认或有可复现证据）：
- SwiftyJSON：两个 bool 的 `<=` / `>=` 退化为相等比较（`JSON(true) >= JSON(false)` 为 false）。
- Expression：`AnyExpression("true + 1")` 得 2（Bool 桥接成 NSNumber 落入数值加法；源码里也有 TODO 质疑）。
- JhHarmonyDemo：`JhPreferencesUtils` 的 bool/number/model 方法调用了 `JhAESPreferencesUtils.saveString/getString`，疑似复制粘贴错误。
- interview-handbook：`getPercentText` 未处理 `total === 0`，返回 `'Infinity%'` / `'NaN%'`。
- LinysBrowser：`isFn('foo')` 返回 true（只判断长度 > 1 且以 F 开头）。

**迭代过程**：每轮试用的子代理都把 CLI/Skill 的问题按「最重要」列出，共修复约 80 处，例如 SwiftPM `Source/` 目录、Gradle `--tests` 绑定到错误任务、Hilt 改写字节码导致 JaCoCo 丢数据、`src/testDemo` 测试源集、鸿蒙三方包被误桩、iOS 同 target 测试互相串覆盖率、报告中的重复/截断等。

## 已知限制

- iOS：SwiftPM 包和 Xcode 工程（iOS 模拟器）都已实测；xcodebuild 每次运行几十秒，变异测试要控制 `--max`。只有 Command Line Tools 时 XCTest 不可用，已有 XCTest 用例跑不了（baseline 为 0%），只能用 Swift Testing。UI 测试、真机不在范围内。
- Android：只覆盖 JVM 本地单测（src/test）；`android.util.Log` 等在没有 Robolectric / `isReturnDefaultValues` 时会抛异常，相应分支不会被覆盖。
- 鸿蒙：hvigor 路径已在 DevEco Studio 26（HarmonyOS 26.0.0 SDK）上实测；跑的是本地单测（Previewer 运行时），系统 API 大多是模拟实现，设备相关逻辑和 `ohosTest`（Instrument Test）/UI 测试不在范围内。`compileSdkVersion` 写死成旧版本、`hvigor-config.json5` 锁定插件版本但没有 `~/.npmrc` 的工程，hvigor 无法构建，unitgen 会自动改用 shim 并说明原因。shim 只对纯逻辑可信：`@kit.*`/`@ohos.*` 是空桩，ArkUI struct/@Builder 被挖空，不跑 ArkTS 编译器（用 lint 近似，实测仍有漏网，例如 `expect(void 调用)`）。struct 里的私有方法、模块未导出的代码都无法测试，brief 会提前警告。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test（解析器、门禁相关单测）
```

调试：`UNITGEN_VERBOSE=1` 打印执行的命令；`UNITGEN_KEEP_COV=1` 保留 SwiftPM 的覆盖率 JSON 和鸿蒙 shim 的转译产物/V8 原始数据。

安全性：`mutate` 临时改被测源码，写日志 `.unitgen/mutation-in-progress.json`；鸿蒙 hvigor 运行时临时替换 `List.test.ets`（`.unitgen/harmony-list.json`），iOS 隔离验证时临时挪开同 target 的测试文件、改写 `Package.swift`。任何 unitgen 命令启动和退出时都会在持有锁的前提下还原它们。已实测：Agent 会话在三个工程的变异运行中途被整体杀掉，下一条 `unitgen status` 自动接管过期锁并还原了全部源码。
