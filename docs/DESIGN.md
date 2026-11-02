# 设计说明

为什么这样做、每个平台怎么实现。使用说明见 [README](../README.md)。

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

## 三端实现

| | 识别 | 运行与覆盖率 | 生成测试位置 |
|---|---|---|---|
| iOS（SwiftPM） | `Package.swift` | `swift test --enable-swift-testing --enable-code-coverage`，解析 llvm-cov 导出（与 `llvm-cov export -format=lcov` 逐行一致） | 独立 test target `<Target>UnitGenTests`（Package.swift 末尾带标记的块） |
| iOS（Xcode） | `.xcodeproj` / `.xcworkspace`（两者并存时 `--adapter xcode`） | `xcodebuild test` + iOS 模拟器，`-only-testing` 隔离，`xccov` 读覆盖率 | 现有测试 target 里的 `<类>UnitGenTests.swift`，需要时登记到 project.pbxproj |
| Android | `settings.gradle(.kts)` | 自动发现每个模块的单测任务（含 flavor），`-I` 注入 JaCoCo init script，**不改任何构建文件**；兼容 configuration cache / isolated projects | `src/test/<kotlin|java>/<包路径>/<类>UnitGenTest.kt`，`--tests` 只跑这一个类，`--rerun` 防缓存 |
| 鸿蒙 | `build-profile.json5`（或 git 忽略了它时的 `build-profile.template.json5`） | 默认 hvigor：自动发现 DevEco，按 DevEco 本地测试流程（`isLocalTest`/`unitTestMode`/`buildRoot=.test`）在 Previewer 里跑，真实 ArkTS 编译器；verify/mutate 时把 `List.test.ets` 临时指向被测文件，别处编译不过的旧测试不影响；读 `coverageReport.json`。备选 Node shim：TS 转译 .ets、ArkUI struct/@Builder 挖空、hypium 兼容实现、按 source map 逐段映射 V8 覆盖率、ArkTS 限制 lint | `<module>/src/test/<文件>.unitgen.test.ets`，自动登记到 `List.test.ets` |

## 安全性：被改动的文件总能还原

`mutate` 临时改被测源码，并写日志 `.unitgen/mutation-in-progress.json`；鸿蒙 hvigor 运行时临时替换 `List.test.ets`（`.unitgen/harmony-list.json`）；iOS 隔离验证时临时挪开同 target 的其他生成测试、改写 `Package.swift`。任何 unitgen 命令启动和退出时都会在持有锁的前提下还原它们。

锁文件 `.unitgen/run.lock` 记录监督进程、worker 和所有后代进程（PID + 启动时间）。被强杀（SIGKILL、关掉终端、Agent 会话中断）后，下一条命令会确认这些进程都已退出，停掉能确认身份的残留进程，接管锁并还原上面这些文件。超时和取消会终止测试的整棵进程树，包括自己另开进程组的测试助手（如 `swiftpm-testing-helper`）；鸿蒙 hvigor 守护进程和它启动的 Previewer 不在这棵树里，unitgen 单独停掉本项目的守护进程和 Previewer。

已实测：Agent 会话在三个工程的变异运行中途被整体杀掉，下一条 `unitgen status` 自动接管过期锁并还原了全部源码。
