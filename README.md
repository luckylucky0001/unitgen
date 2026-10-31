# unitgen

[English](#english) · 中文

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

**实测情况**：已在 DevEco Studio 26 和 Xcode 16.4 的真实工具链上，用 10 个开源项目做过完整验证（写测试 → verify → mutate），包括 [Kingfisher](https://github.com/onevcat/Kingfisher)（24k★）、[Ink](https://github.com/JohnSundell/Ink)、[Rainbow](https://github.com/onevcat/Rainbow)、[interview-handbook](https://github.com/HarmonyOS-Next/interview-handbook-project)、[LinysBrowser_NEXT](https://github.com/awaLiny2333/LinysBrowser_NEXT)、[DSBridge-HarmonyOS](https://github.com/751496032/DSBridge-HarmonyOS)。验证方法、逐个文件的覆盖率和变异得分、在这些项目里发现的疑似 bug，见下文[第二轮验证](#第二轮验证2026-10-31deveco-studio-26--xcode-164真实工具链)。

## English

unitgen is a coverage-driven unit-test backfilling tool for **iOS (Swift), Android (Kotlin/Java) and
HarmonyOS (ArkTS)**: a CLI plus an Agent Skill for Claude Code and TRAE. An agent (or a model in
unattended mode) writes the tests; unitgen decides what to test and keeps only tests that compile,
pass repeatedly, assert something and add line coverage, then measures their strength with mutation
testing.

**Install** (Node ≥ 22.18; the platform toolchain you need: Xcode, JDK 17 + Android SDK, or DevEco
Studio, which is found automatically):

```bash
git clone https://github.com/luckylucky0001/unitgen.git ~/unitgen
cd ~/unitgen && npm ci
~/unitgen/bin/unitgen --help          # or link it into your PATH
ln -sfn ~/unitgen/skills/unitgen ~/.claude/skills/unitgen   # optional: Claude Code Skill
```

**Use** (in the project root; add `.unitgen/` to its `.gitignore`):

```bash
unitgen doctor                      # project type, toolchain, which runner and why
unitgen baseline                    # the project's own tests + coverage, once
unitgen targets                     # files with the most untested logic
unitgen brief <source>              # context for writing the test (uncovered lines marked)
unitgen verify <test> --target <source>   # ACCEPTED / COMPILE_ERROR / TEST_FAILURES / FLAKY / NO_GAIN / ...
unitgen mutate <test>               # mutation score; survivors listed with ids
unitgen report                      # .unitgen/REPORT.md
```

HarmonyOS: runs DevEco's real hvigor + ArkTS compiler in the Previewer runtime (no device or emulator
needed); without DevEco, a Node shim runs pure-logic tests. iOS: SwiftPM packages, or `.xcodeproj` on
an iOS Simulator with `--adapter xcode`. The Skill ([skills/unitgen/SKILL.md](skills/unitgen/SKILL.md))
describes the whole agent workflow. Exit codes: 0 passed, 1 command/environment error, 2 quality gate
failed, 130 cancelled.

**Validation**: run end to end on real toolchains (DevEco Studio 26, Xcode 16.4) on 10 open-source
projects, among them Kingfisher, Ink, Rainbow, interview-handbook, LinysBrowser_NEXT and
DSBridge-HarmonyOS (per-file coverage and mutation scores in the tables below), then out-of-box tests
from a fresh clone, each by an agent that only read the README and Skill, on CoolMallArkTS, SwiftDate,
SwiftyJSON and Aigis. Every unitgen bug these found is listed with its fix under
「这轮发现并修复的 unitgen 问题」.

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
cd ~/unitgen && npm ci
mkdir -p ~/.local/bin && ln -sfn ~/unitgen/bin/unitgen ~/.local/bin/unitgen
export PATH="$HOME/.local/bin:$PATH"          # 写进 ~/.zshrc 可永久生效
unitgen --help

# 作为 Claude Code Skill（可选）
mkdir -p ~/.claude/skills && ln -sfn ~/unitgen/skills/unitgen ~/.claude/skills/unitgen
```

演示建议：先在一个开源工程上跑 `unitgen doctor` → `baseline` → `targets`，再让 Claude Code 用 Skill 补 1–2 个文件，最后 `unitgen mutate` 和 `unitgen report`。Android 工程第一次构建会下载 Gradle 依赖，建议提前跑一次 `baseline` 预热；鸿蒙工程第一次 hvigor 构建也会慢一些。`doctor` 会说明用的是哪个运行器以及原因，有问题先按它的提示处理。

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

`.unitgen/` 是 unitgen 在工程里的工作目录（状态、日志、报告），建议加进工程的 `.gitignore`。

鸿蒙工程先在工程根目录执行一次 `ohpm install`（DevEco Studio 打开工程时也会自动执行）；同时有 `Package.swift` 和 `.xcodeproj` 的 iOS 工程，想走 Xcode + 模拟器时，每条命令都加 `--adapter xcode`。

需要 Node ≥ 22.18（直接运行 TypeScript 源码，无构建步骤）。PATH 里没有合适的 Node 时，`bin/unitgen` 会改用 DevEco Studio 自带的 Node；如果仓库旁边有 `unitgen-env/env.sh`，会自动用里面的 Node / JDK 17 / Android SDK 路径，只对 unitgen 进程生效。

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
- 速度：
  - 鸿蒙的 hvigor 默认使用守护进程，热启动后单次运行约 1 秒，比冷启动快 3 倍左右；设 `UNITGEN_HVIGOR_DAEMON=0` 可以关闭。死循环的测试或变异体会把守护进程和它启动的 Previewer 卡住，而它们不在 unitgen 启动的进程树里。所以运行超时、被取消，或者开跑前发现本项目还有残留的 Previewer 时，unitgen 会停掉本项目的守护进程（`hvigorw --stop-daemon`），再按 PID + 启动时间清理命令行指向本项目 `.test/` 的 Previewer。下一次运行会冷启动一个新的守护进程，其他项目的守护进程不受影响。
  - 变异体的超时按已经跑完的变异体实际耗时自适应（3 倍中位数 + 10 秒，下限 20 秒），死循环的变异体不会每个都白等 60 秒。
  - 已经判定过的变异体，在测试文件没改动之前不会重跑。
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

已实测：`unitgen generate --llm claude --limit 1` 在 qs-arkts 的 `proto_guard.ets` 上用 hvigor 一次通过，新增覆盖 7 行，变异 6/7 杀死，全程 66 秒。

## 三端实现

| | 识别 | 运行与覆盖率 | 生成测试位置 |
|---|---|---|---|
| iOS（SwiftPM） | `Package.swift` | `swift test --enable-swift-testing --enable-code-coverage`，解析 llvm-cov 导出（与 `llvm-cov export -format=lcov` 逐行一致） | 独立 test target `<Target>UnitGenTests`（Package.swift 末尾带标记的块） |
| iOS（Xcode） | `.xcodeproj` / `.xcworkspace`（两者并存时 `--adapter xcode`） | `xcodebuild test` + iOS 模拟器，`-only-testing` 隔离，`xccov` 读覆盖率 | 现有测试 target 里的 `<类>UnitGenTests.swift`，需要时登记到 project.pbxproj |
| Android | `settings.gradle(.kts)` | 自动发现每个模块的单测任务（含 flavor），`-I` 注入 JaCoCo init script，**不改任何构建文件**；兼容 configuration cache / isolated projects | `src/test/<kotlin|java>/<包路径>/<类>UnitGenTest.kt`，`--tests` 只跑这一个类，`--rerun` 防缓存 |
| 鸿蒙 | `build-profile.json5`（或 git 忽略了它时的 `build-profile.template.json5`） | 默认 hvigor：自动发现 DevEco，按 DevEco 本地测试流程（`isLocalTest`/`unitTestMode`/`buildRoot=.test`）在 Previewer 里跑，真实 ArkTS 编译器；verify/mutate 时把 `List.test.ets` 临时指向被测文件，别处编译不过的旧测试不影响；读 `coverageReport.json`。备选 Node shim：TS 转译 .ets、ArkUI struct/@Builder 挖空、hypium 兼容实现、按 source map 逐段映射 V8 覆盖率、ArkTS 限制 lint | `<module>/src/test/<文件>.unitgen.test.ets`，自动登记到 `List.test.ets` |

## 第二轮验证（2026-10-31，DevEco Studio 26 + Xcode 16.4，真实工具链）

第一轮只有 Command Line Tools，鸿蒙全部跑在 Node shim 上。这一轮装好了 DevEco Studio（HarmonyOS 26.0.0 SDK，hvigor + ArkTS 编译器 + Previewer 运行时）和 Xcode 16.4（iOS 18.6 模拟器），在 **10 个开源项目**上完整实测（写测试 → verify → mutate），其中 8 个是这轮新加的，另外 2 个（LinysBrowser_NEXT、interview-handbook）是第一轮测过、这次换真工具链复验的；另有 4 个知名项目（Wechat_HarmonyOS、HarmoneyOpenEye、Gramony、legado-Harmony）只用来检查 doctor/baseline/targets 的兼容性。

### 验证方法

1. **选项目**：用 GitHub API 按 star 数搜索鸿蒙 ArkTS 和 Swift 项目，排除没有源码的（例如 legado-Harmony 的 main 分支只剩 README）和纯 UI 的，保留逻辑代码多的。每个项目都是 `git clone --depth 1` 得到的干净副本，只在副本里改动。
2. **独立执行**：每个项目交给一个**只读 Skill 文档**的独立子代理，按 `doctor → baseline → targets → brief → 写测试 → verify → mutate → report` 完整走一遍。期望值只能来自读代码或可信的外部基准（RFC 测试向量、CPython zlib），不能抄测试输出。子代理同时记录遇到的每个工具问题，并区分哪些是工具 bug、哪些是自己写错了。
3. **修复再复验**：收集到的问题逐个修复，每个修复都配单测（单测从 31 个增加到 49 个）。修完后用最终代码把所有项目从头重跑一遍：重建基线（只含项目原有测试）、复验每个已接受的测试文件、重跑变异测试。下表的数字都来自这次统一重跑。
4. **两种运行器交叉验证**：同一批鸿蒙测试分别在 shim 和 hvigor 上跑，对比结果是否一致（见下文）。
5. **故障注入**：几个子代理和监督会话被整体强杀在变异测试中途（生产代码处于被改动的状态），再验证下一条命令能否自动恢复；另外构造了一个会让测试死循环的变异体，验证超时后不会有进程残留。

### 结果

| 项目 | 平台 · 运行器 | 目标文件 | 目标文件覆盖率 | 新增测试 | 变异得分 |
|---|---|---|---|---:|---|
| [Kingfisher](https://github.com/onevcat/Kingfisher) 24,405★ | iOS · Xcode + iOS 模拟器 | `KingfisherError.swift` | 29% → **99%**（62 → 211 / 213 行） | 14 | 67%（10/15 杀死，评估 15/42） |
| [Kingfisher](https://github.com/onevcat/Kingfisher) 24,405★ | iOS · Xcode + iOS 模拟器 | `ImageFormat.swift` | 44% → **98%**（24 → 54 / 55 行） | 11 | 100%（15/15 杀死，评估 15/29；其中 1 个靠崩溃，2 个判为等价） |
| [Ink](https://github.com/JohnSundell/Ink) 2,539★ | iOS · SwiftPM | `List.swift` | 87% → **99%**（140 → 159 / 161 行） | 10 | 80%（12/15 杀死，评估 16/40；其中 1 个靠崩溃，1 个判为等价） |
| [Rainbow](https://github.com/onevcat/Rainbow) 1,941★ | iOS · SwiftPM | `ConditionalStyleBuilder.swift` | 53% → **100%**（67 → 127 / 127 行） | 24 | 100%（15/15 杀死，评估 18/28） |
| [Rainbow](https://github.com/onevcat/Rainbow) 1,941★ | iOS · SwiftPM | `String+Rainbow.swift` | 89% → **100%**（199 → 223 / 223 行） | 23 | 100%（23/23 杀死，评估 23/23；其中 2 个靠崩溃） |
| [interview-handbook-project](https://github.com/HarmonyOS-Next/interview-handbook-project) 541★ | 鸿蒙 · hvigor | `base.ets` | 0% → **100%**（0 → 6 / 6 行） | 9 | 100%（8/8 杀死，评估 11/11；1 个判为等价） |
| [interview-handbook-project](https://github.com/HarmonyOS-Next/interview-handbook-project) 541★ | 鸿蒙 · hvigor | `InterviewItemModel.ets` | 0% → **100%**（0 → 12 / 12 行） | 8 | 100%（11/11 杀死，评估 11/11） |
| [LinysBrowser_NEXT](https://github.com/awaLiny2333/LinysBrowser_NEXT) 292★ | 鸿蒙 · hvigor | `url.ets` | 0% → **81%**（0 → 153 / 189 行） | 25 | 94%（33/35 杀死，评估 41/165；2 个判为等价） |
| [LinysBrowser_NEXT](https://github.com/awaLiny2333/LinysBrowser_NEXT) 292★ | 鸿蒙 · hvigor | `url-ext.ets` | 0% → **100%**（0 → 108 / 108 行） | 9 | 97%（33/34 杀死，评估 36/72；其中 1 个靠崩溃，6 个判为等价） |
| [DSBridge-HarmonyOS](https://github.com/751496032/DSBridge-HarmonyOS) 182★ | 鸿蒙 · hvigor | `BaseBridge.ts` | 0% → **94%**（0 → 218 / 233 行） | 44 | 88%（21/24 杀死，评估 30/119） |
| [DSBridge-HarmonyOS](https://github.com/751496032/DSBridge-HarmonyOS) 182★ | 鸿蒙 · hvigor | `AsyncCallbackHelper.ts` | 0% → **100%**（0 → 32 / 32 行） | 12 | 100%（12/12 杀死，评估 14/14） |
| [qs-arkts](https://github.com/wgli-collab/qs-arkts) 45★ | 鸿蒙 · hvigor | `utils_encode.ets` | 0% → **97%**（0 → 115 / 118 行） | 17 | 80%（12/15 杀死，评估 19/102；6 个判为等价） |
| [qs-arkts](https://github.com/wgli-collab/qs-arkts) 45★ | 鸿蒙 · hvigor | `proto_guard.ets` | 0% → **100%**（0 → 7 / 7 行） | 18 | 86%（6/7 杀死，评估 7/7） |
| [Home-Assistant-HarmonyOS-Next](https://github.com/gentslava/Home-Assistant-HarmonyOS-Next) 17★ | 鸿蒙 · hvigor | `P2pHomeAssistantRepository.ets` | 0% → **91%**（0 → 50 / 55 行） | 13 | 91%（10/11 杀死，评估 17/17；2 个判为等价） |
| [Home-Assistant-HarmonyOS-Next](https://github.com/gentslava/Home-Assistant-HarmonyOS-Next) 17★ | 鸿蒙 · hvigor | `HomeAssistantStore.ets` | 0% → **100%**（0 → 45 / 45 行） | 13 | 100%（15/15 杀死，评估 18/37；其中 1 个靠崩溃） |
| [HarmonyOS_2048](https://github.com/amazingcoderpro/HarmonyOS_2048) 15★ | 鸿蒙 · hvigor | `SoundManger.ets` | 0% → **45%**（0 → 42 / 93 行） | 14 | 40%（6/15 杀死，评估 17/20；1 个判为等价） |
| [lxmusic-harmony](https://github.com/Adamaik/lxmusic-harmony) 13★ | 鸿蒙 · hvigor | `Inflate.ets` | 0% → **100%**（0 → 149 / 149 行） | 19 | 87%（13/15 杀死，评估 19/153；其中 3 个靠崩溃，29 个判为等价） |

口径说明：
- 表中 SwiftPM 项目（Ink、Rainbow）的行数是当时的口径，llvm-cov 会把函数内的空行和注释行计为可执行行。现在的版本不再计入这些行，重跑时分母会略小，覆盖率百分比基本不变。
- 「改造前」是只跑项目原有测试的基线，鸿蒙这几个项目原来都没有测到这些文件。
- 对项目副本的改动：除了新增的测试文件、unitgen 自己注册测试用的 `List.test.ets` / `Package.swift` / `project.pbxproj`，只有下面三处构建配置，都是为了能在 DevEco 26 上构建，生产代码一行没动：
  - qs-arkts：加了 `@ohos/hypium` 依赖；去掉了写死的 `compileSdkVersion`（API 24，本机 SDK 是 26）；去掉了 hvigor 插件的版本锁定。
  - DSBridge：把 `@ohos/hypium` 从 1.0.6 升到 1.0.25。在原版本下，unitgen 正确报告「覆盖率拿不到」（INFRA_ERROR）。
  - lxmusic：按项目自己 README 的说明，从模板复制了 `build-profile.json5`。
- 覆盖率由真工具链测出：hvigor 的 `coverageReport.json`，Xcode/SwiftPM 的 llvm-cov/xccov。
- 变异得分 = 杀死数 / (杀死 + 存活)，只统计用当前测试文件测过的变异体。编译不过的变异体不计入分数，但算作「已评估」。
- 每个文件这一轮最多跑 15 个变异体（`--max 15`），所以「评估 X/Y」里 X 往往小于候选总数 Y。重复运行会接着评估剩下的。
- 表里只列在真工具链上测出的结果。interview-handbook 的 `QuestionItemModel.ets` 所在的 home 模块在 hvigor 下构建不了（缺少依赖声明，见下文），只在 shim 下验证过：0% → 100%（82 行），7 个测试，变异 16/16 杀死。

怎么看这些数字：
- 17 个目标文件里，15 个的覆盖率到了 91% 以上，所有新增测试都在真工具链上通过，没有改动任何生产代码。
- 变异得分低的几项都是真实的测试缺口，没有被工具掩盖：
  - **KingfisherError 67%**：上一版变异算子不会改 `case .x: return 2001` 里的错误码，当时报的是「100%（8/8）」。补上这类算子后，5 个存活的变异全是 `3001…3005` 这几个错误码，说明测试没有逐个断言它们。
  - **BaseBridge**：一开始只有 60%，因为存活的 6 个里有 4 个是删掉项目自己封装的 `LogUtils.d/e(...)` 日志调用，这种改动观察不到，属于噪音。调优后 unitgen 能识别项目自己的日志封装，不再为它们生成变异，得分变成 88%，剩下的存活都是真正的缺口。
  - **SoundManger 40%**：存活的变异体都是对 `soundPool.play/stop/off` 的调用。这些调用在 Previewer 里是模拟实现，只有真设备或替身才能观察到，brief 里已经给出了警告。
- 判为「等价」的变异体，每一个都写了理由（`unitgen note`）。例如 Inflate.ets 的 29 个来自 12 行，都是读取之前一定会被覆盖的初始值、或者永远不会被读到的表槽位。

兼容性检查（只跑 doctor / baseline / targets）：

| 项目 | 结果 |
|---|---|
| [legado-Harmony](https://github.com/mgz0227/legado-Harmony) 2,228★ | main 分支没有源码，doctor 报「no module with src/main/ets」 |
| [HarmoneyOpenEye](https://github.com/WinWang/HarmoneyOpenEye) 618★ | API 9 老工程，锁定了 hvigor 插件 2.4.2，又没有 `~/.npmrc`，自动改用 shim 并说明原因；基线 0%，targets 正常 |
| [Wechat_HarmonyOS](https://github.com/ausboyue/Wechat_HarmonyOS) 492★ | 没有任何测试，hvigor 下得到 0% 基线；`PhotoPickerUtils`、`AudioCapturerManager` 等设备能力文件正确地排到了纯逻辑文件后面 |
| [Gramony](https://github.com/Gramony/Gramony) 180★ | 没声明 hypium，`ohpm install` 也因为缺少本地编译产物而失败，自动改用 shim 并给出两条警告 |


### 被测项目里发现的疑似 bug

测试按当前行为写断言，并在代码里标注 `UNITGEN-SUSPECT`。下面每一条都对照过源码，标了「真机」的在 hvigor/Previewer 或 iOS 模拟器上实际跑过。

| 项目 | 发现 | 依据 |
|---|---|---|
| LinysBrowser_NEXT | Punycode 把 emoji 编成 `8c9by4f`（拆成了两个代理项），RFC 3492 规定 U+1F4A9 应编为 `ls8h`。原因是在 Previewer 运行时里 `Array.from(label)` 按 UTF-16 码元迭代（我单独验证过：`Array.from('💩').length === 2`，按 JS 规范应为 1） | 真机（Previewer）。Node/shim 下按规范迭代，这个用例反而能通过；真设备上的方舟运行时没测 |
| LinysBrowser_NEXT | `SCHEME_REGEX` 把 `localhost:8080` 当成 scheme 为 `localhost` 的 URI，于是不再补 `http://` | 真机 |
| LinysBrowser_NEXT | IPv6 正则在最后一个 `:` 处切分，`64:ff9b::192.0.2.33`（RFC 6052）这类合法地址被拒绝 | 真机 |
| interview-handbook | `getPercentText` 没处理 `total === 0`，页面会显示 `NaN%` / `Infinity%` | 真机 |
| interview-handbook | `new InterviewItemModel({} as InterviewItem)` 把类上的默认值全部覆盖成 `undefined`，两个组件都这样构造占位对象 | 真机 |
| DSBridge-HarmonyOS | 异步方法抛异常时，返回给 H5 的是 `code: 0`，而同步分支是 `-1`（第 183 行先设了 code 再调用） | 真机 |
| DSBridge-HarmonyOS | `hasNativeMethod` 不检查命名空间是否存在，`nope.dsinit` 返回 true，可实际调用会失败 | 真机 |
| HarmonyOS_2048 | `} catch(error) {` 前面没有 `try`，被解析成了一个叫 `catch` 的类方法，`loadAudio` 里的同步异常没有任何地方捕获 | 真机：编译通过，并且能直接调用 `sm.catch()` |
| Home Assistant（手表） | `onIncoming` 没有 try/catch，一条格式错误的消息就会从 WearEngine 回调里抛出；`refreshEntity` 也没有 catch，和 `sync` 的处理不一致 | 真机 |
| lxmusic-harmony | 项目自带的 HeartMode 测试在真机上同样失败：余弦相似度为 `1.0000000000000002 > 1`，而且推荐出来的正是种子歌曲本身；`LocalMusic.test.ets` 已经跟不上 `LocalSong` 的新字段，编译不过 | 真机：项目自己的测试 |
| Kingfisher | `cannotSetCacheFileAttribute` 的错误描述拼接时少了空格；声明了 `static let domain` 却没实现 `errorDomain`，桥接成 NSError 后 domain 和文档不符 | iOS 模拟器 |
| Kingfisher | `JPEGMarker.RSTn(n)` 计算 `0xD0 + n` 时，n ≥ 0x30 会 UInt8 溢出直接 trap | 读代码（测了会让测试进程崩溃） |

### shim 和真工具链的交叉验证

- **一致的部分**：lxmusic 自带的 95 个测试里，失败的就是同样那 5 个。qs-arkts、HA、DSBridge、lxmusic 上的生成测试，在两种运行器下的通过情况一致。纯逻辑文件的覆盖率只差在可执行行的统计口径上。
- **只有真工具链能发现的**：
  - `expect(返回 void 的调用)`：TypeScript 允许，ArkTS 编译器拒绝。
  - `@Trace` 字段存的是可观察代理，`store.cards === before` 在真机上为 false。
  - hypium 1.0.19 之前的版本没有 `.message()`。
  - Punycode 的 UTF-16 迭代差异。
  - 项目旧测试的类型错误。

  前三条现在已经由 shim 的 lint 和 `@Trace` 模拟提前拦下，最后两条只能靠 hvigor 发现，这也是 hvigor 成为默认运行器的原因。

### 这轮发现并修复的 unitgen 问题

| 类别 | 问题 | 修复 |
|---|---|---|
| 鸿蒙 hvigor | 原来的 hvigor 路径实际跑不起来：去找根本不存在的 lcov 文件，测试失败时也照样判通过 | 按 DevEco 本地测试流程重写：解析 `test_result.txt` 和 `coverageReport.json`，自动发现 DevEco |
| 鸿蒙 hvigor | 一个编译不过的旧测试会让所有 verify 失败 | verify/mutate 时把 `List.test.ets` 临时指向被测文件；基线自动排除编译不过的旧测试并列出来 |
| 鸿蒙 hvigor | hypium < 1.0.19 时 Previewer 丢掉覆盖率，被判成 NO_GAIN，误导写测试的人一直补测试 | 判为 INFRA_ERROR 并给出升级建议（已验证升级到 1.0.25 后恢复正常） |
| 鸿蒙 hvigor | 覆盖率工具把类型标注里的函数类型当成从没调用过的函数，标注所在行永远显示未覆盖 | 识别并剔除这类虚假区域 |
| 鸿蒙 hvigor | 某个模块缺少依赖声明，导致整个基线作废 | 按模块隔离；指出没声明的那个包；`targets` 把这些模块的文件排到最后 |
| 鸿蒙 shim | TypeScript 把两行合成一行时有一行丢了覆盖率；`?.`/`&&` 短路让整行被判为未覆盖；`if (...) {` 后面的 `{` 让条件行被判为未覆盖 | 按 source map 逐段映射，忽略短路子表达式的范围 |
| 鸿蒙 shim | 含 `struct` 的文件被整个换成桩，同一文件里导出的工具函数也测不了 | 只挖掉 struct/@Builder，其余代码正常加载 |
| 鸿蒙 lint | 误报 `Record` 的下标访问；漏报 import 未导出的符号、`expect(void)`、`.message()` | 全部修正，并补了单测 |
| 鸿蒙 hvigor | 手动删掉的生成测试（没走 `unitgen reject`）还留在 `List.test.ets` 的 import 里，项目自己的 DevEco 测试构建从此编译不过 | 每次运行前清掉指向已不存在的 `*.unitgen.test.ets` 的条目；其他测试的条目不动 |
| 鸿蒙 起步 | 没有测试的工程、只有 DevEco 模板测试的工程、`build-profile.json5` 被 git 忽略的工程，都没法开始 | 0% 基线直接有效；读模板文件；doctor 说明原因 |
| 鸿蒙 兼容 | `compileSdkVersion` 写死成旧版本、插件锁定需要 `~/.npmrc` 的工程，hvigor 无法构建 | doctor 提前识别并自动改用 shim，说明原因 |
| iOS SwiftPM | `swift-tools-version` < 6.0 的包（大多数库都是）里，Swift Testing 的测试 0 个被执行，verify 报 NO_TESTS | 自动加 `--enable-swift-testing` |
| iOS SwiftPM | 带 `main.swift` 的 `.target`（Ink 的 CLI、Rainbow 的 Playground）被排成第一个目标 | 当作可执行目标排除 |
| 进程管理 | 死循环的变异体超时后只杀掉了 `swift test`，自己另开进程组的 `swiftpm-testing-helper` 一直在后台涨内存 | 杀整棵进程树；监督进程把后代进程的 PID + 启动时间记进锁文件 |
| 进程管理 | hvigor 守护进程模式下，一个死循环变异体卡住 Previewer 后，后面所有变异体都被误判成「超时 = 杀死」（CoolMallArkTS 开箱实测时发现）；下一条 verify 无限挂起；卡住的 Previewer 占满一个 CPU 核、约 1 GB 内存，进程树清理够不着 | 超时、取消或开跑前发现残留时，停掉本项目的守护进程和它的 Previewer；单个测试文件的 hvigor 运行超时从 30 分钟降到 15 分钟；超时杀死的变异计为「仅崩溃检出」；变异结果按运行器区分，shim 测出的结果不会在 hvigor 下复用 |
| 进程管理 | 被强杀后要手动确认 PID 再删锁，变异过的源码要等下一条命令才能还原 | 下一条命令自动接管过期锁，停掉能确认身份的残留进程，还原源码、`List.test.ets` 和 `Package.swift` |
| 变异测试 | 升级后，用旧版本标过的 `--equivalent` 失效，得分莫名下降（CoolMallArkTS 的 ValidationUtil 从 100% 掉到 97%） | 识别旧格式的键，第一次命中时改写成新格式 |
| 变异测试 | 每个 ArkTS/Swift 数据类都会产生注定编译不过的变异：删掉构造函数里对无默认值字段的赋值、把整个构造函数当成语句删掉、`x == null \|\| x.y` 改成 `&&`。hvigor 下每个要白跑 2–3 秒（CoolMallArkTS 的 CategoryTree 28 个候选里有 9 个） | 不再生成这几类变异（只看同一个类里的字段声明）。用 10 个项目已有的变异结果对照：去掉的 12 个之前全都编译不过，真正的杀死和幸存一个没少。CategoryTree 降到 21 个候选、2 个编译不过 |
| 鸿蒙 hvigor | 一次中断的构建（编译不过的变异体、超时）会写坏 hvigor 自己的 `init_coverage.json`，之后每次 verify 都报 INFRA_ERROR「覆盖率拿不到」，还误导人改用 shim（Aigis 开箱实测） | 每次带覆盖率的运行前检查这个文件，坏了就删掉模块的 `.test/` 让 hvigor 重新插桩；复现后验证一次 verify 4 秒内自动恢复 |
| 鸿蒙 brief | 系统 API 返回的对象（`const mac = cryptoFramework.createMac()` 之后的 `mac.update()`、`mac.doFinal()`）没有标 `!~`，子代理照着 RFC 向量写断言，结果 Previewer 里 HMAC 是模拟的 | 由系统 API 返回值派生出的变量所在行一并标 `!~` |
| 鸿蒙 targets | 只导出一个 `@Builder` 的页面被排成 logic | ArkUI 剥离后留下的空壳不再算导出 |
| iOS Xcode | 工程在 `/tmp` 这类符号链接路径下时，xccov 报的路径对不上，基线 0/0；brief 里 `@testable import SwiftyJSON_iOS` 用了 target 名（模块其实叫 `SwiftyJSON`）；部署目标 iOS 9 也建议用 Swift Testing；构建产物写进 `~/Library/.../DerivedData`（SwiftyJSON 开箱实测） | 所有路径统一解析符号链接；模块名读 `PRODUCT_MODULE_NAME`；部署目标低于 iOS 13 / macOS 10.15 时只建议 XCTest；构建放在 `.unitgen/DerivedData` |
| verify | 环境错误（INFRA_ERROR）或一次失败的重新验证，会把已接受的测试连同覆盖率和变异历史一起丢掉，`mutate` 随后报一个看不懂的「pass --target」；INFRA_ERROR 退出码是 2 | 环境错误不改动状态，退出码改为 1；真正失败时该文件暂停计数，历史保留，再次通过后恢复；`status` 和 `mutate` 会说明原因 |
| 变异测试 | 测试文件没变时，已知的幸存者每次都重跑（Aigis 一轮 21 次里 15 次是重复）；`x = .string`、`obj.secret = undefined` 这类赋值、抛出的错误消息、返回的模板字符串都没有变异体；`"0" + s` 被改成 `"0" - s`，`self.init(...)` 被删，都注定编译不过；每个变异体的完整测试输出刷屏 | 幸存者只在测试文件改动后重跑；补上这几类变异（赋值删除只在该行没有其他变异时生成）；跳过注定编译不过的两类；变异体的构建输出只写日志 |
| 变异测试 | ArkTS 编译器会把 `c === 0x2D` 收窄成字面量类型：字符判断链 `c === 0x2D \|\| c === 0x2E \|\| …` 里把前面的 `===` 改成 `!==`、或把 `\|\|` 改成 `&&`，都编译不过（「types '45' and '46' have no overlap」）。qs-arkts 的 utils_encode 84 个变异里 14 个白跑 | 在 hvigor 下不生成这几类（链末尾那个比较、`typeof x === '…'` 照常生成；Node shim 不做类型检查，照常生成）。utils_encode 95 个候选全部判定，编译不过的降到 2 个，得分 92%。行末的 `\|\|`、`&&` 原先没有变异体，现在也有 |
| 状态 | `.unitgen` 里的覆盖率用绝对路径记录，工程目录被移动、改名或复制后，已接受测试的覆盖率在报告里消失（Aigis 副本里 utils.ets 从 100% 变成 19%） | 改为相对工程根目录记录（旧的绝对路径照常读取） |
| iOS SwiftPM | llvm-cov 把函数里的空行、注释、`#if/#else` 计为可执行行，brief 把空行标成未覆盖，前后分母也对不上（Splash：0/33 → 36/36） | 这些行一律不计 |
| 变异测试 | 唯一能编译的变异被标成等价后，门禁报 FAILED「no mutant was evaluated」、报告写 0%（Splash 的 Font）；删掉「声明时没赋值的局部常量」的赋值注定编译不过；`var x: Int?` 行尾的 `?` 被当成三元表达式续行，下一行的删除变异全部丢失 | 门禁改为 NOT_APPLICABLE、报告写 n/a；跳过这类删除；修正续行判断 |
| 运行 | 在工程子目录里执行命令报「No supported project」 | 像 git 一样向上查找工程根目录；鸿蒙模块目录继续向上找到应用根目录 |
| 鸿蒙 hvigor | 警告很多的模块（harmony-utils：151 条 ArkTS:WARN）里，COMPILE_ERROR 只给出 80 行警告、看不到真正的错误：hvigor 在 stdout 管道写完前就退出，超过约 64 KB 的部分丢失 | 输出不完整时改读 hvigor 自己的 `.hvigor/outputs/build-logs/build.log`；终端只显示 hvigor 进度和错误（基线的 stderr 从 10,751 行降到 336 行），完整输出照样写日志 |
| 鸿蒙 brief/targets | import 解析跨到了下一条 import：项目自己的枚举 `DateType` 被当成系统 API，相关行标成 `!~`，文件被排成 platform | 一条 import 不再跨过另一条 import |
| 变异测试 | hvigor 下枚举比较链（`type == DateType.YmdHms \|\| type == DateType.YmdHm`）、`if / else if` 链、字面量写在左边（`undefined !== a && null !== a`）里的取反仍然编译不过：DateHelper 56 个里 16 个 | 收窄判断覆盖这三种写法；对照实测结果，去掉的 16 个全是编译不过的，没有误伤 |
| 基线 | 重跑基线时，已经接受的生成测试被算进「改造前」（报告写成 6% → 34%，实际起点是 0） | 基线只跑项目原有的测试（四种运行器都处理了） |
| 基线 | 因为平台桩而失败的旧测试让基线作废；shim 和 hvigor 的数据混在一起 | shim 下自动容忍这类失败（会列出来），其他情况用 `--allow-failing`；记录运行器，不一致时拒绝 verify |
| 变异测试 | Swift 的 `if cond {`、尾随闭包、成员赋值、`case .x: return 2001`、返回的字符串都没有变异体：Rainbow 的 ConditionalStyleBuilder 只有 2 个候选，Kingfisher 的「100%」是虚高 | 补上这些算子；不再生成 `$0 → $1`、类型联合 `0 \| 1` 这类注定编译不过的变异 |
| 变异测试 | 删除项目自己封装的日志调用（`LogUtils.d(...)`）也算作变异，存活了就拉低分数 | 识别以 Log/Logger/LogUtils 结尾的封装，`Catalog`、`Dialog` 这类名字不受影响 |
| 变异测试 | 进程崩溃杀死的变异被算成普通 killed；报告只汇总最后一轮；重跑时用已杀死的变异填预算；`--equivalent` 写多次只保留最后一个；id 在版本之间会漂移 | 累计统计（只算当前测试内容测出的结果）；没有新变异时直接给出结果；`--equivalent` 可重复，按稳定的键记录 |

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
