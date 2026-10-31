# unitgen

中文 · [English](README.en.md)

给 **iOS（Swift）、Android（Kotlin/Java）、鸿蒙（ArkTS）** 工程补单元测试的工具：一个命令行工具，加一份给 AI 编程助手（Claude Code、TRAE）用的 Skill。

AI 负责写测试，unitgen 负责两件事：**决定测什么**（按未覆盖的逻辑代码给文件排序，给出写测试需要的上下文），以及**决定留下哪些测试**。一个测试文件只有同时满足下面几条才会被接受：能编译、全部通过、重跑一遍结果不变、里面有断言、确实让覆盖率上升。之后再用变异测试检查断言是否真的能发现代码被改坏。

```
doctor    检查工程类型和工具链
baseline  跑工程原有的测试，记下改造前的覆盖率
targets   按「未覆盖的逻辑行」给源文件排序
brief     为一个源文件生成写测试用的上下文（源码 + 未覆盖行标记 + 约定 + 可用的测试替身 + 同类已有测试）
（AI 写测试）
verify    门禁：编译 → 全部通过 → 重跑不 flaky → 有断言 → 新增覆盖 > 0
mutate    变异测试：改动被测代码，看测试能否发现
report    汇总成 .unitgen/REPORT.md
```

思路来自 Meta 的 TestGen-LLM / ACH 和 Qodo Cover-Agent：生成测试不难，难的是筛选。为什么做这个工具、与现有开源方案的对比，见 [docs/DESIGN.md](docs/DESIGN.md)。

## 验证情况

在 DevEco Studio 26、Xcode 16.4 和 Android SDK（Gradle）的真实工具链上，用 20 个开源项目完整走过「写测试 → verify → mutate → report」，其中 9 个由只读过本 README 和 Skill 的 AI 从零开始完成。部分结果：

| 项目 | 平台 | 目标文件 | 覆盖率 | 变异得分 |
|---|---|---|---|---|
| [SwiftyJSON](https://github.com/SwiftyJSON/SwiftyJSON) 22.9k★ | iOS · SwiftPM | `SwiftyJSON.swift` | 88% → 98% | 97% |
| [Kingfisher](https://github.com/onevcat/Kingfisher) 24.4k★ | iOS · Xcode + 模拟器 | `ImageFormat.swift` | 44% → 98% | 100% |
| [SwiftDate](https://github.com/malcommac/SwiftDate) 7.7k★ | iOS · SwiftPM | `DateComponents+Extras.swift` | 61% → 100% | 100% |
| [harmony-utils](https://github.com/787107497/harmony-utils) 122★ | 鸿蒙 · hvigor | `DateHelper.ets` | 0% → 98% | 100% |
| [LinysBrowser_NEXT](https://github.com/awaLiny2333/LinysBrowser_NEXT) 292★ | 鸿蒙 · hvigor | `url-ext.ets` | 0% → 100% | 97% |
| [DSBridge-HarmonyOS](https://github.com/751496032/DSBridge-HarmonyOS) 182★ | 鸿蒙 · hvigor | `BaseBridge.ts` | 0% → 94% | 88% |
| [architecture-samples](https://github.com/android/architecture-samples) 45.9k★ | Android · Gradle | `TaskNetworkDataSource.kt` | 0% → 100% | 100% |
| [Pokedex](https://github.com/skydoves/Pokedex) 8.4k★ | Android · Gradle（多模块） | `DetailRepositoryImpl.kt` | 89% → 100% | 100% |
| [ObjectMapper](https://github.com/tristanhimmelman/ObjectMapper) 9.1k★ | iOS · Xcode + 模拟器 | `Map.swift` | 75% → 98% | 100% |

全部 35 个目标文件的数字、验证方法、在这些项目里发现的疑似 bug，以及验证中发现并修复的 unitgen 问题，见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 安装

**前置条件**，只装你要用的平台：

| 平台 | 需要 |
|---|---|
| 所有平台 | Node.js ≥ 22.18（`node -v`）。PATH 里没有合适的 Node 时，自动使用 DevEco Studio 自带的 Node |
| 鸿蒙 | 推荐安装 [DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/)，unitgen 会自动找到它，用真实的 hvigor、ArkTS 编译器和 Previewer 运行时跑本地单测，不需要模拟器或真机。工程要在 devDependencies 里声明 `@ohos/hypium`（≥ 1.0.19 才能拿到覆盖率），并执行过 `ohpm install`。没有 DevEco 时改用内置的 Node shim，只适合纯逻辑代码 |
| iOS | Xcode。SwiftPM 包用 `swift test`，`.xcodeproj` 工程在 iOS 模拟器上跑。只有 Command Line Tools 时只能跑 Swift Package 里的 Swift Testing 测试 |
| Android | JDK 17+（`JAVA_HOME`）和 Android SDK（`ANDROID_HOME`，或工程里的 `local.properties`）。Apple 芯片的 Mac 请用 arm64 的 JDK（例如 `brew install openjdk@17`），x86_64 的 JDK 在 Rosetta 下构建很慢 |

**安装 unitgen**：

```bash
git clone https://github.com/luckylucky0001/unitgen.git ~/unitgen
cd ~/unitgen && npm ci
mkdir -p ~/.local/bin && ln -sfn ~/unitgen/bin/unitgen ~/.local/bin/unitgen
export PATH="$HOME/.local/bin:$PATH"     # 写进 ~/.zshrc 或 ~/.bashrc 长期生效
unitgen --help
```

不想改 PATH 的话，直接用 `~/unitgen/bin/unitgen` 也可以。unitgen 直接运行 TypeScript 源码，没有构建步骤；保留这个目录，不要移动或删除。

**检查**：进入你的工程目录运行 `unitgen doctor`。它会说明识别出的工程类型、用的是哪个运行器以及原因；有问题时按它给出的提示处理（例如鸿蒙工程会给出 DevEco 自带 ohpm 的完整路径）。

## 使用

### 方式一：在 Claude Code 里用（推荐）

安装 Skill：

```bash
mkdir -p ~/.claude/skills && ln -sfn ~/unitgen/skills/unitgen ~/.claude/skills/unitgen
```

然后在工程里对 Claude Code 说「用 unitgen 给这个工程补单测」，或者指定文件：「用 unitgen 给 `src/utils/url.ets` 补单测」。[Skill](skills/unitgen/SKILL.md) 规定了完整流程、每种结果怎么处理，以及硬性规则：不改生产代码和构建文件、不弱化断言、期望值必须来自读代码。最后它会给出覆盖率前后对比、变异得分、发现的疑似 bug 和没能覆盖的部分。

### 方式二：在 TRAE / TRAE CN 里用

TRAE 自己写测试、调用 unitgen 做检查，不需要 Claude CLI 或 API Key。安装脚本（macOS/Linux）会安装 Skill 和它引用的文件，并把 CLI 链接到 `~/.local/bin`：

```bash
cd ~/unitgen && npm ci
sh scripts/install-trae.sh --project /absolute/path/to/your-project   # 装到工程的 .trae/skills/unitgen/
sh scripts/install-trae.sh --global                                   # 或装成 TRAE CN 全局技能 ~/.trae-cn/skills/unitgen/
```

确保 TRAE 终端的 PATH 里有 `~/.local/bin`（可用 `UNITGEN_BIN_DIR` 换目录），或者在对话里给出 CLI 的绝对路径。工具链路径可以放进仓库外的环境文件，每条命令都带上：

```bash
cp scripts/unitgen-env.example.sh ~/unitgen-env.sh    # 填写 Node、JAVA_HOME、ANDROID_HOME，不要提交到仓库
UNITGEN_ENV=~/unitgen-env.sh unitgen doctor -C /absolute/path/to/your-project
```

TRAE 的每次工具调用是独立的进程，上一条命令里 `export` 的变量不会保留，所以每条命令都要带 `UNITGEN_ENV`。可以这样给 TRAE 下任务：

> 使用 unitgen 给当前工程补单测。先 doctor 和 baseline，基线成功后按 targets 和 brief 选择逻辑文件，读取关联的数据类和测试替身的实际实现，生成测试，逐个 verify，再 mutate 检查断言强度，最后输出 report。只新增测试，不改产品代码、已有测试和构建文件。报告覆盖率的分子分母、变异测试的评估数和没有覆盖的范围。

Windows 上请手动把整个 `skills/unitgen/` 复制到对应的 Skill 目录；安装脚本没有在 Windows 上验证。

### 方式三：自己用命令行

```bash
cd <你的工程>                      # 在工程的任意子目录里也可以，unitgen 会向上找到工程根目录
unitgen doctor
unitgen baseline                   # 一次即可；工程代码大改后再跑
unitgen targets                    # 最该补测试的文件排在前面
unitgen brief <源文件>             # 把输出交给你用的模型，或者自己照着写
# …… 把测试写到 brief 指定的路径 ……
unitgen verify <测试文件>          # --target <源文件> 可省略，按文件名推断
unitgen mutate <测试文件>          # 列出没被发现的变异（survivor），补断言后再跑
unitgen report                     # 写出 .unitgen/REPORT.md
```

`verify` 的输出：

```
verdict: ACCEPTED  (library/src/test/countdown.unitgen.test.ets, 4s)
tests: 2 run, 0 failed
target coverage now: 10/10 lines (100%)
lines covered only by this file: 10 (in the target: 10)
```

`mutate` 的输出（节选）：

```
  mutant 3 (budget 20, 8 still to decide of 11) [4.1] line 4 (- -> +): killed (no result within 20s: the mutant hangs)
  mutant 4 (budget 20, 7 still to decide of 11) [5.1] line 5 (+ -> -): killed
mutation score: 100%  (killed 11, of which 2 only by a crash, not an assertion, survived 0, did not compile 0)
all 11 candidate mutants evaluated with the current test file (11 run now)
gate: PASSED (minimum 80%)
```

### 方式四：无人值守

不需要 AI 编程助手，unitgen 自己调用模型，跑同样的「brief → 写测试 → verify → mutate → 回喂失败信息」循环：

```bash
unitgen generate --llm claude --limit 5       # 需要 PATH 里有 claude CLI
unitgen generate --llm anthropic --limit 5    # 需要 ANTHROPIC_API_KEY
unitgen generate --llm 'cmd:<从 stdin 读提示词、向 stdout 输出代码的命令>'
```

重试用完仍不合格的文件会被隔离到 `.unitgen/rejected/`，命令返回 2。

## verify 的结果

| 结果 | 含义 | 下一步 |
|---|---|---|
| `ACCEPTED` | 通过全部检查，计入覆盖率 | 跑 `mutate` |
| `COMPILE_ERROR` | 测试编译不过，附编译器原文 | 按错误改测试 |
| `TEST_FAILURES` | 有测试失败，附断言差异；涉及模拟实现的系统 API 时会特别指出 | 重读代码改期望值；确认是代码的 bug 时，按现有行为断言并加 `// UNITGEN-SUSPECT: 原因` |
| `FLAKY` | 第一次通过、重跑失败 | 去掉时间、顺序、共享状态等不确定因素 |
| `NO_GAIN` | 都通过，但没有覆盖任何新的行 | 对着 brief 里标 `!` 的行补测试 |
| `NO_ASSERTIONS` / `NO_TESTS` | 没有断言 / 一个测试都没跑到 | 加断言；检查测试类名是否与 brief 一致 |
| `INFRA_ERROR` | 环境问题，不是测试的问题（缺 SDK、没装依赖、生产代码编译不过、拿不到覆盖率等），不计入尝试次数，已接受的文件不受影响 | 按提示修环境，或换一个目标 |

一个已经接受的文件再次 verify 失败时，它暂时不计入覆盖率和报告，历史记录保留，再次通过后恢复。

## 变异测试

`mutate` 每次改动被测代码里已被覆盖的一行（取反条件、改比较符、改常量、清空返回的字符串、删掉调用或赋值等），再跑这个测试文件：

- **killed**：测试失败了，说明断言能发现这种改动。因异常、越界或死循环而失败的单独统计为「仅靠崩溃检出」。
- **survived**：改了代码测试照样通过。输出会给出变异的编号（如 `[12.2]`）和改动后的那一行。补一条能让它失败的断言，`verify` 后再 `mutate`。
- **等价变异**：改动根本不影响行为（例如一个之后会被覆盖的初始值）。用 `unitgen mutate <测试文件> --equivalent 12.2` 排除，并用 `unitgen note "…"` 写明理由。效果只能通过模拟 API 才能看到的变异不算等价。
- **得分** = killed /（killed + survived）。编译不过的变异会被丢弃，不计分。默认门禁 80%（`--min-score`）。
- 每次最多运行 `--max` 个变异（默认 15），已经判定过的变异在测试文件改动之前不会重跑，多跑几次就能评估完全部候选。没评估完时门禁会写明「on 19 of 71 candidates」，这时的得分只是抽样结果。

单次变异的耗时：hvigor 约 1–3 秒，SwiftPM/Gradle 3–10 秒，Xcode 20–40 秒（建议 `--max 10`）。进入死循环的变异体要等到超时才算杀死（按已完成变异体的耗时自适应，最少 20 秒），所以循环多的代码一轮会慢不少。

## 各平台说明

**鸿蒙**
- 默认运行器是 hvigor：按 DevEco 的本地单测流程在 Previewer 里运行，真实的 ArkTS 编译器，覆盖率来自 hvigor 的 `coverageReport.json`。
- 用不了 hvigor 时，`doctor` 会说明原因，并自动改用 Node shim（也可用 `UNITGEN_HARMONY_MODE=shim` 强制）。常见原因：没跑 `ohpm install`、没声明 `@ohos/hypium`、`compileSdkVersion` 和已装 SDK 不一致、hvigor 插件锁定了版本却没有 `~/.npmrc`。
- shim 用 TypeScript 转译 `.ets`，所有 `@kit.*`/`@ohos.*` 都是空桩，不跑 ArkTS 编译器，只适合纯逻辑。
- 系统 API 在 Previewer 里大多也是模拟实现。brief 用 `!~` 标出调用这些 API 的未覆盖行：测它们周围的逻辑，不要断言它们的返回值。
- 运行器在 baseline 时记录下来，verify 和 mutate 必须用同一个。
- 如果一个测试或变异体进入死循环，卡住的 hvigor 守护进程和 Previewer 会被自动清理。只影响本工程，其他工程的守护进程不受影响。

**iOS**
- 只有 `Package.swift` 时走 SwiftPM，只有 `.xcodeproj`/`.xcworkspace` 时走 Xcode + iOS 模拟器。两者都有时默认 SwiftPM；想用模拟器（例如要测 UIKit 代码），每条命令都加 `--adapter xcode`。
- 测试框架以 brief 为准。`swift-tools-version` < 6.0 的包要求 XCTest，因为它们的 CI 里普通的 `swift test` 不会跑 Swift Testing；部署目标低于 iOS 13 / macOS 10.15 的 Xcode 工程也一样。其余情况用 Swift Testing。
- Xcode 的构建产物放在 `.unitgen/DerivedData`，不影响你打开着的 Xcode。unitgen 自己的 xcodebuild 运行会打开 `ENABLE_TESTABILITY`（`@testable import` 需要），并关掉老的 gcov 覆盖率开关（它们会让 llvm 覆盖率全是 0），这些只作用于这次运行，不改工程。

**Android**
- 自动发现每个模块的单测任务（包括 flavor），用 `-I` 注入 JaCoCo 初始化脚本，不改任何构建文件。
- 一个模块的测试执行到的其他模块代码也计入覆盖率。某个模块构建不了时（例如依赖要求更高的 compileSdk），基线照样测量其他模块，并列出这个模块和 Gradle 给的原因，它的文件排在 `targets` 最后。
- 只覆盖 JVM 本地单测（`src/test`）。第一次构建会下载 Gradle 依赖，比较慢。没有声明测试框架的模块（没有 JUnit / kotlin-test），brief 会提示换一个模块。

## unitgen 会动工程里的哪些文件

| | 新增 | 修改 |
|---|---|---|
| 所有平台 | `.unitgen/`（状态、日志、REPORT.md；自带 `.gitignore`），建议把它加进工程的 `.gitignore` | — |
| 鸿蒙 | `<模块>/src/test/<文件>.unitgen.test.ets`；hvigor 自己生成的 `<模块>/.test/` 输出（大多数工程已经忽略 `**/.test`） | `<模块>/src/test/List.test.ets`：登记生成的测试，让 DevEco 也能跑到 |
| iOS SwiftPM | `Tests/<Target>UnitGenTests/` | `Package.swift` 末尾一段 `// unitgen:begin … // unitgen:end` 标记块（独立的测试 target） |
| iOS Xcode | 现有测试 target 里的 `<类>UnitGenTests.swift` | 需要时登记到 `project.pbxproj`（原文件备份在 `.unitgen/`） |
| Android | `src/test/<kotlin\|java>/<包路径>/<类>UnitGenTest.kt` | — |

生产代码、已有测试和构建配置都不会被改。`mutate` 运行期间会临时改动被测源文件，结束后（包括被强杀之后的下一条命令）一定会还原。

**撤销**：`unitgen reject <测试文件> "原因"` 把一个生成的测试移到 `.unitgen/rejected/`，并取消它的登记；手动删掉的生成测试，unitgen 下次运行时会自动从 `List.test.ets` 里移除。去掉 SwiftPM 的标记块、删除 `.unitgen/`，就恢复成原样。

## 常见问题

**`doctor` 说鸿蒙用的是 shim，不是 hvigor。** 按 `runner:` 那一行说的原因处理。最常见的是还没在工程根目录执行 `ohpm install`：doctor 会给出 DevEco 自带 ohpm 的完整路径。

**基线失败：工程原有的测试有失败的。** 输出里会列出失败的用例。确认这些失败与你无关后，用 `unitgen baseline --allow-failing`，unitgen 会用其余通过的测试作为基线。

**verify 一直是 `INFRA_ERROR`。** 看反馈里的原因，常见的有：生产代码本身编译不过、ohpm 依赖没装、hypium 版本低于 1.0.19 导致覆盖率拿不到、hvigor 的覆盖率中间文件被打断的构建写坏（unitgen 会自动删掉模块的 `.test/` 重建，再 verify 一次即可）。这些都不是测试的问题，不要为了绕过它去改测试。

**提示 `project locked by a running unitgen command`。** 同一个工程同时只能跑一条 unitgen 命令，等它结束或按提示停掉它。如果上一条已经被强杀，下一条命令会自动确认并接管，同时还原被改动的文件；只有确实还有构建进程在跑时才会提示，并给出具体的 kill 命令。不要手动删 `.unitgen/run.lock`。

**`mutate` 太慢。** 用 `--max` 控制每次的数量，分几次跑完；Xcode 建议 `--max 10`。

**编译错误只看到一堆警告。** 已修复：hvigor 的输出被截断时，unitgen 会改读 hvigor 自己的 `.hvigor/outputs/build-logs/build.log`。完整的构建输出始终在 `.unitgen/logs/` 里，每条命令的结尾都会给出日志路径。

**工程目录移动或改名之后。** 没有影响，`.unitgen` 里的路径都相对工程根目录记录。

## 命令参考

```
unitgen <命令> [选项]

doctor                     识别工程类型，检查工具链
modules                    列出模块/target，以及生成的测试放在哪里
baseline                   跑原有测试 + 覆盖率          --allow-failing
targets                    按未覆盖逻辑给文件排序        --limit <n>（20）--all-kinds
brief <源文件>             生成写测试用的上下文          --out <文件> --feedback <文件>
verify <测试文件>          门禁                          --target <源文件> --reruns <n>（1）--allow-no-gain --quarantine
mutate <测试文件>          变异测试                      --target <源文件> --max <n>（15）--min-score <百分比>（80）
                                                         --equivalent <编号|行号>[,...]（可重复）
generate                   无人值守循环                  --llm anthropic|claude|cmd:<sh> --model <id> --limit <n>（5）
                                                         --attempts <n>（3）--max <n> --min-score <百分比>
reject <测试文件> [原因]   隔离一个生成的测试
note <文字>                给报告加一条备注
report                     写出 .unitgen/REPORT.md
status                     基线、已接受、已隔离的数量

通用选项：-C <目录>（工程根目录，默认从当前目录向上查找）  --adapter harmony|gradle|swiftpm|xcode
          --module <名称>  --json（结果输出到 stdout，进度在 stderr）
```

**退出码**：0 通过（或变异测试不适用）；1 命令、参数或环境错误；2 质量门禁未通过；130 被取消。

**环境变量**：

| 变量 | 作用 |
|---|---|
| `UNITGEN_HARMONY_MODE=hvigor\|shim` | 强制鸿蒙运行器 |
| `UNITGEN_HVIGOR_DAEMON=0` | hvigor 不用守护进程，每次冷启动（慢约 3 倍） |
| `DEVECO_STUDIO_HOME` / `DEVECO_SDK_HOME` | DevEco 不在 `/Applications/DevEco-Studio.app` 时指定位置 |
| `UNITGEN_QUIET=1` | 终端不显示构建进度（日志照写） |
| `UNITGEN_VERBOSE=1` | 打印执行的命令 |
| `UNITGEN_ENV=<env.sh>` | 只对 unitgen 进程生效的工具链环境文件（不设时，若 unitgen 目录旁边有 `unitgen-env/env.sh` 就自动使用它） |

构建进度和诊断信息输出到 stderr，`--json` 的结果输出到 stdout，不要把两者合并后再解析。用管道记录输出时，请用支持 `pipefail` 的 shell，以保留 unitgen 的退出码。

## 已知限制

- **鸿蒙**：跑的是本地单测（Previewer 运行时），系统 API 大多是模拟实现。设备相关逻辑、`ohosTest`（Instrument Test）和 UI 测试不在范围内。shim 只对纯逻辑可信。struct 里的私有方法、模块没有导出的代码测不到，brief 会提前提示。
- **iOS**：UI 测试和真机不在范围内。xcodebuild 每次运行要几十秒。只有 Command Line Tools 时，工程已有的 XCTest 用例跑不了，基线为 0%。
- **Android**：只有 JVM 本地单测；没有 Robolectric 或 `isReturnDefaultValues` 时，`android.util.Log` 等调用会抛异常。APK 安装、真机 API 和 Compose UI 测试不在范围内。
- **Windows**：没有实测。

## 开发

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # node --test
```

`UNITGEN_VERBOSE=1` 打印执行的命令；`UNITGEN_KEEP_COV=1` 保留 SwiftPM 的覆盖率 JSON 以及鸿蒙 shim 的转译产物和 V8 原始数据。实现细节见 [docs/DESIGN.md](docs/DESIGN.md)。
