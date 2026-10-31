# unitgen 验证记录

unitgen 在真实开源项目上的验证过程、结果，以及验证中发现并修复的问题。使用说明见 [README](../README.md)。

- [Windows（CI）](#windowsci)：GitHub Actions windows-latest 上的单测和端到端测试
- [第四轮：从 main 开箱测试，含 Android](#第四轮从-main-开箱测试含-android2026-10-31)：Android SDK 装好后的 Android 工程，以及新的 Xcode / 鸿蒙工程
- [第三轮：开箱测试](#第三轮开箱测试2026-10-31从-github-全新安装)：6 个项目，只给 README 和 Skill 的子代理从零开始使用
- [第二轮：真实工具链](#第二轮验证2026-10-31deveco-studio-26--xcode-164真实工具链)：DevEco Studio 26 + Xcode 16.4，10 个项目
- [发现并修复的 unitgen 问题](#发现并修复的-unitgen-问题)
- [第一轮：只有 Command Line Tools](#第一轮验证结果2026-10-21本机macos--command-line-tools无-xcode--deveco)

## Windows（CI）

本机没有 Windows，所以在 GitHub Actions 的 windows-latest 上实测，Node 22.18 和 24 都跑（见 `.github/workflows/checks.yml`）：

- 全部单测和 typecheck；
- 通过 `bin\unitgen.cmd` 启动：`--help`，以及在空目录里 `doctor` 以退出码 1 给出明确提示；
- 端到端（`scripts/e2e-jvm.mjs`，Linux、macOS 上同样跑）：生成一个 Gradle/Java 小工程，路径里故意带空格，依次跑 doctor、baseline、targets、verify、mutate、report，要求 verify 为 ACCEPTED、变异门禁通过。
- 鸿蒙端到端（`scripts/e2e-harmony-shim.mjs`，三个系统都跑）：生成一个 ArkTS 小工程，用 Node shim 跑同样的流程，并检查生成的测试登记进了 `List.test.ets`。DevEco 需要华为账号下载，CI 里装不了，所以 Windows 上的 hvigor 路径仍没有实测。

第一次在 Windows 上跑时发现的问题：
- 5 个单测的夹具写死了 POSIX 路径（测试本身的问题）；
- 鸿蒙覆盖率按源码目录匹配文件时没有统一路径格式，Windows 上盘符大小写或 `/` 与 `\` 不同就会丢掉覆盖率数据（代码问题，已修）。
- Android/Gradle：JaCoCo 用 `/` 写源文件路径（`calc/Calc.java`），unitgen 拿它去匹配 Windows 的 `\` 路径，一个类都对不上，基线是 0/0（端到端测试发现，代码问题，已修）。同时 Windows 上解析路径改用 `realpathSync.native`，把 `C:\Users\RUNNER~1` 这种 8.3 短路径展开成工具报告的长路径。

另外补上了 Windows 支持：`bin\unitgen.cmd`；`gradlew.bat`、`hvigorw.bat` 这类 `.bat`/`.cmd` 经 `cmd.exe` 运行并正确加引号（Node 20 起不允许直接 spawn）；查找命令时考虑 `PATHEXT`；`--llm cmd:` 在 Windows 上用 `cmd.exe`。鸿蒙的 hvigor 路径（DevEco for Windows）在 Windows 上没有实测；Xcode 不适用于 Windows。

## 第四轮：从 main 开箱测试，含 Android（2026-10-31）

第三轮的修复合并进 main 之后，再用同样的方法测 main：子代理只拿到 README 和 Skill，从 GitHub 克隆 main 开始。这一轮本机装好了 Android SDK（command-line tools、platform 35/36、arm64 的 JDK 17），所以 Android 也实测了。

| 项目 | 平台 · 运行器 | 目标文件 | 目标文件覆盖率 | 变异得分 |
|---|---|---|---|---|
| [ObjectMapper](https://github.com/tristanhimmelman/ObjectMapper) 9,124★ | iOS · Xcode + iOS 模拟器 | `Map.swift` | 75% → **98%** | 80% → 100%（评估 23/45，抽样；2 个靠崩溃，3 个判为等价） |
| [ObjectMapper](https://github.com/tristanhimmelman/ObjectMapper) 9,124★ | iOS · Xcode + iOS 模拟器 | `DictionaryTransform.swift` | 57% → **100%**（42 / 42 行） | 当时没有可生成的变异（下标赋值还没有删除变异，已补上） |
| [joplin-hap](https://github.com/Lancenas/joplin-hap) 9★ | 鸿蒙 · hvigor | `ItemSerializer.ets` | 0% → **99%**（0 → 248 / 251 行） | 80% → 100%（评估 69/69；4 个靠崩溃，3 个判为等价） |
| [joplin-hap](https://github.com/Lancenas/joplin-hap) 9★ | 鸿蒙 · hvigor | `MarkdownRenderer.ets` | 0% → **99%**（0 → 190 / 191 行） | 98%（评估 116/116；29 个靠崩溃，大多是死循环；14 个判为等价） |
| [Pokedex](https://github.com/skydoves/Pokedex) 8,375★ | Android · Gradle（多模块） | `DetailRepositoryImpl.kt` | 89% → **100%**（17 → 19 / 19 行） | 100%（4/4） |
| [Pokedex](https://github.com/skydoves/Pokedex) 8,375★ | Android · Gradle | `TypeResponseConverter.kt` | 27% → **100%**（3 → 11 / 11 行） | 没有可生成的变异 |
| [architecture-samples](https://github.com/android/architecture-samples) 45,878★ | Android · Gradle | `TaskNetworkDataSource.kt` | 0% → **100%**（0 → 18 / 18 行） | 33% → 100%（3/3）：两个存活的变异是删掉 `delay(...)`，`runTest` 的虚拟时间让它们看不出来，补了对 `testScheduler.currentTime` 的断言后杀死 |

只跑到基线的项目：[PhoneNumberKit](https://github.com/marmelroy/PhoneNumberKit)（5,394★，Xcode）修复前基线是 0%，修复后 55.2%（见下表）；[android-showcase](https://github.com/igorwojda/android-showcase)（6,811★，Android，6 个模块）修复前只识别出一个错误的模块，修复后 53 个测试、31.4%。

- 每个项目的生产代码都没有改动。鸿蒙这一轮没有发现阻塞性问题，只有输出和文档上的小问题（已修）。
- 这轮发现的问题都列在下面「发现并修复的 unitgen 问题」的最后几行，每个修复都在发现它的那个项目上复验过。
- 子代理在 joplin-hap 里标出 4 个疑似 bug，例如 `markdownToHtml('#tag')` 进入死循环、字面量反斜杠加 `n` 序列化后不能还原。

## 第三轮：开箱测试（2026-10-31，从 GitHub 全新安装）

前两轮由我自己或熟悉工具的子代理完成。这一轮模拟一个第一次接触 unitgen 的用户：每个项目交给一个**只拿到 README 和 Skill** 的独立子代理，从 GitHub 克隆 unitgen、按 README 安装、按 Skill 走完 `doctor → baseline → targets → brief → 写测试 → verify → mutate → report`，记录遇到的每个问题。每轮发现的问题修复后，下一个项目用修复后的分支继续测。

| 项目 | 平台 · 运行器 | 目标文件 | 目标文件覆盖率 | 新增测试 | 变异得分（最终） |
|---|---|---|---|---:|---|
| [SwiftyJSON](https://github.com/SwiftyJSON/SwiftyJSON) 22,925★ | iOS · SwiftPM（也试了 Xcode） | `SwiftyJSON.swift`（1,397 行单文件） | 88% → **98%**（815 → 903 / 922 行） | 45 | 97%（60 杀死 / 2 存活，评估 64/74；3 个靠崩溃，3 个判为等价） |
| [SwiftDate](https://github.com/malcommac/SwiftDate) 7,687★ | iOS · SwiftPM | `DateComponents+Extras.swift` | 61% → **100%**（106 → 174 / 174 行） | 16 | 100%（52/52，3 个靠崩溃） |
| [SwiftDate](https://github.com/malcommac/SwiftDate) 7,687★ | iOS · SwiftPM | `ISOFormatter.swift` | 45% → **98%**（47 → 103 / 105 行） | 9 | 100%（10/10） |
| [Splash](https://github.com/JohnSundell/Splash) 1,876★ | iOS · SwiftPM | `AttributedStringOutputFormat.swift` | 0% → **100%**（0 → 32 / 32 行） | 14 | 100%（6/6） |
| [Splash](https://github.com/JohnSundell/Splash) 1,876★ | iOS · SwiftPM | `Font.swift` | 0% → **100%**（0 → 33 / 33 行） | 11 | 50%（1/2；存活的是 `font ?? .systemFont(...)`，测试没检查加载到的字体有没有被用上） |
| [harmony-utils](https://github.com/787107497/harmony-utils) 122★ | 鸿蒙 · hvigor（12 个模块） | `ArrayUtil.ets` | 0% → **98%**（0 → 54 / 55 行） | 32 | 70% → 100%（22/22，评估 24/24；2 个靠崩溃，4 个判为等价） |
| [harmony-utils](https://github.com/787107497/harmony-utils) 122★ | 鸿蒙 · hvigor | `DateHelper.ets` | 0% → **98%**（0 → 170 / 173 行） | 26 | 100%（40/40，评估 56/153） |
| [CoolMallArkTS](https://github.com/Joker-x-dev/CoolMallArkTS) 79★ | 鸿蒙 · hvigor | `ValidationUtil.ets` | 0% → **100%**（0 → 25 / 25 行） | 19 | 93% → 100%（33/33；2 个靠崩溃（死循环），1 个判为等价） |
| [CoolMallArkTS](https://github.com/Joker-x-dev/CoolMallArkTS) 79★ | 鸿蒙 · hvigor | `CategoryTree.ets` | 0% → **100%**（0 → 64 / 64 行） | 12 | 87% → 100%（19/19；1 个判为等价） |
| [Aigis](https://github.com/iamhyc/Aigis) 54★ | 鸿蒙 · hvigor | `utils.ets` | 0% → **100%**（0 → 97 / 97 行） | 32 | 100%（60/60；2 个靠崩溃，7 个判为等价） |
| [Aigis](https://github.com/iamhyc/Aigis) 54★ | 鸿蒙 · hvigor | `otpUtils.ets` | 0% → **100%**（0 → 157 / 157 行） | 30 | 48%（22/46，评估 52/52）：24 个存活都只改了送进/读出 HMAC 的数据，而 Previewer 里的 cryptoFramework 是模拟实现，测试无法观察 |

- 子代理在这些项目里共标出 12 个疑似 bug（`UNITGEN-SUSPECT`：SwiftDate 4、Aigis 5、CoolMallArkTS 2、harmony-utils 1），例如 harmony-utils 的 `DateHelper.getDateByStr` 把「日」当成「时」用（每月 24–31 日得到 Invalid Date），Aigis 的 HOTP 计数器 ≥ 2^32 时丢掉高位、base32 的 `=` 填充被吃掉，CoolMallArkTS 的分类树在混用嵌套和扁平数据时同一节点出现两次。
- 每个项目的生产代码都没有改动；`git status` 里只有新增的测试文件、`.unitgen/` 和 unitgen 自己登记测试用的文件。
- 开箱测试发现的工具问题全部修了，列在下面「发现并修复的 unitgen 问题」里（从「hvigor 守护进程模式下，一个死循环变异体…」那一行开始）。修完后在原项目上复验，例如：CoolMallArkTS 上死循环变异体不再拖垮后面的变异体；Aigis 上被写坏的 hvigor 覆盖率文件能自动修复；SwiftyJSON 放在 `/tmp` 下时 Xcode 基线从 0/0 恢复到 814/922；harmony-utils 上编译错误不再被 151 条警告淹没；qs-arkts 的 utils_encode 在 hvigor 下编译不过的变异体从 84 个里的 14 个降到 95 个里的 2 个。
- 没有覆盖到的：Android 这一轮没有测（当时本机没有 Android SDK，见第四轮）；Windows 没有测。

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

## 发现并修复的 unitgen 问题

第二轮和第三轮发现的问题；第一轮的约 80 处修复见该节末尾。

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
| Android | `settings.gradle.kts` 里跨多行的 `include(...)` 没被解析，`includeBuild("build-logic")` 反而被当成模块（android-showcase：doctor 报 1 个模块，基线说「没有覆盖任何代码」） | 完整解析 `include(...)`、跳过 `includeBuild`、支持 `projectDir` 重映射；一个模块都找不到时 doctor 报错 |
| Android | 一个模块构建失败就让整个基线作废，也不说是哪个模块（Pokedex 的 `:app`：依赖要求 compileSdk 37、manifest 合并 minSdk 冲突） | 其他模块照常测量；构建失败的模块连同 Gradle 给的原因一起列出，它的文件排到 `targets` 最后 |
| Android | 失败原因取到一行废弃警告（「It will be removed in version 10.0 of the Android Gradle plugin」），真正的 `e:` 编译错误被跳过 | 先给 Kotlin `e:`、javac `error:` 和 Gradle 的「What went wrong」 |
| Android | 一个模块的测试执行到的其他模块代码不计覆盖率（Pokedex：core-data 的测试跑到的 PokedexClient 显示 0%） | 每个模块的报告读入本次所有测试任务的执行数据；Pokedex 基线从 36.6% 变为 68.1% |
| Android | 没有测试框架依赖的模块，brief 不提示，verify 报 COMPILE_ERROR「Unresolved reference 'junit'」并算一次尝试 | brief 给出 ⚠️；verify 报 INFRA_ERROR |
| Android | 基线把 `tasks --all` 和整个 Gradle 日志打到终端（2.3k–4.5k 行） | 终端只显示失败和结果；一次 verify 共 14 行输出，完整日志照写 |
| iOS Xcode | 工程关掉了 `ENABLE_TESTABILITY` 时，brief 建议的 `@testable import` 编译不过（ObjectMapper）；工程开着老的 gcov 开关时覆盖率全是 0，却被当成有效的 0% 基线（PhoneNumberKit） | unitgen 自己的 xcodebuild 运行加上 `ENABLE_TESTABILITY=YES` 并关掉 gcov 开关（不改工程）；测试通过却一行都没执行时报覆盖率问题。PhoneNumberKit 基线从 0% 变为 55.2% |
| iOS Xcode | 测试 group 的 path 是 `Tests`、文件 path 是 `ObjectMapperTests/X.swift` 这种常见布局下，生成的测试无法登记到 pbxproj | 按同目录已有文件的写法登记 |
| 变异测试 | Swift 的反引号标识符（``return `default` ``）被当成模板字符串变异，注定编译不过；`result[key] = value` 这类下标赋值没有变异体；UIKit 的 cell/view 子类被排成 logic | 修正这三处 |
| 运行 | `mutate` 不打印日志路径；鸿蒙 doctor 退回 shim 时仍显示「status: OK」 | mutate 给出日志路径；可以修复的退回原因显示为 warning |
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
