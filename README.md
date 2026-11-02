# unitgen

中文 · [English](README.en.md)

unitgen 用来给 iOS（Swift）、Android（Kotlin/Java）和鸿蒙（ArkTS）工程补单元测试。它是一个命令行工具，另外带一份 Skill，可以直接在 Claude Code 或 TRAE 里用。

测试由 AI 来写，unitgen 负责挑目标和把关：先按未覆盖的逻辑代码给源文件排序，并为每个文件整理出写测试要用的上下文；测试写好后，只有能编译、全部通过、重跑结果不变、有断言、并且带来新覆盖的才会保留。最后用变异测试看断言能不能发现代码被改坏。

```
doctor    检查工程类型和工具链
baseline  跑工程原有的测试，记录改造前的覆盖率
targets   按未覆盖的逻辑行给源文件排序
brief     为一个源文件生成写测试用的上下文：源码（标出未覆盖行）、约定、可用的测试替身、同类已有测试
（写测试）
verify    检查：编译 → 全部通过 → 重跑不 flaky → 有断言 → 新增覆盖 > 0
mutate    变异测试：改动被测代码，看测试能否发现
report    生成 .unitgen/REPORT.md
```

做法参考了 Meta 的 TestGen-LLM / ACH 和 Qodo Cover-Agent，设计说明和同类工具对比见 [docs/DESIGN.md](docs/DESIGN.md)。

## 验证

在 20 个开源项目上用真实工具链（DevEco Studio 26、Xcode 16.4、Android SDK + Gradle）跑过完整流程。部分结果：

| 项目 | 平台 | 目标文件 | 覆盖率 | 变异得分 |
|---|---|---|---|---|
| [SwiftyJSON](https://github.com/SwiftyJSON/SwiftyJSON) 22.9k★ | iOS · SwiftPM | `SwiftyJSON.swift` | 88% → 98% | 97% |
| [Kingfisher](https://github.com/onevcat/Kingfisher) 24.4k★ | iOS · Xcode + 模拟器 | `ImageFormat.swift` | 44% → 98% | 100% |
| [SwiftDate](https://github.com/malcommac/SwiftDate) 7.7k★ | iOS · SwiftPM | `DateComponents+Extras.swift` | 61% → 100% | 100% |
| [ObjectMapper](https://github.com/tristanhimmelman/ObjectMapper) 9.1k★ | iOS · Xcode + 模拟器 | `Map.swift` | 75% → 98% | 100% |
| [architecture-samples](https://github.com/android/architecture-samples) 45.9k★ | Android · Gradle | `TaskNetworkDataSource.kt` | 0% → 100% | 100% |
| [Pokedex](https://github.com/skydoves/Pokedex) 8.4k★ | Android · Gradle（多模块） | `DetailRepositoryImpl.kt` | 89% → 100% | 100% |
| [harmony-utils](https://github.com/787107497/harmony-utils) 122★ | 鸿蒙 · hvigor | `DateHelper.ets` | 0% → 98% | 100% |
| [LinysBrowser_NEXT](https://github.com/awaLiny2333/LinysBrowser_NEXT) 292★ | 鸿蒙 · hvigor | `url-ext.ets` | 0% → 100% | 97% |
| [DSBridge-HarmonyOS](https://github.com/751496032/DSBridge-HarmonyOS) 182★ | 鸿蒙 · hvigor | `BaseBridge.ts` | 0% → 94% | 88% |

全部 35 个目标文件的数据、验证方法、在这些项目里发现的疑似 bug，见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 安装

按要用的平台准备环境：

| 平台 | 需要 |
|---|---|
| 所有平台 | Node.js ≥ 22.18。PATH 里没有合适的 Node 时，会用 DevEco Studio 自带的 Node |
| 鸿蒙 | 建议安装 [DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/)，unitgen 会自动找到它，用 hvigor 和 ArkTS 编译器在 Previewer 里跑本地单测，不需要模拟器或真机。工程的 devDependencies 里要有 `@ohos/hypium`（1.0.19 及以上才能拿到覆盖率），并且已经执行过 `ohpm install`。没装 DevEco 时会改用内置的 Node shim，只适合纯逻辑代码 |
| iOS | Xcode。SwiftPM 包用 `swift test` 跑，`.xcodeproj` 工程在 iOS 模拟器上跑。只有 Command Line Tools 时，只能跑 Swift Package 里的 Swift Testing 测试 |
| Android | JDK 17+（`JAVA_HOME`）和 Android SDK（`ANDROID_HOME` 或工程里的 `local.properties`）。Apple 芯片的 Mac 用 arm64 的 JDK，例如 `brew install openjdk@17`，x86_64 的 JDK 在 Rosetta 下构建很慢 |

安装 unitgen：

```bash
git clone https://github.com/luckylucky0001/unitgen.git ~/unitgen
cd ~/unitgen && npm ci
mkdir -p ~/.local/bin && ln -sfn ~/unitgen/bin/unitgen ~/.local/bin/unitgen
export PATH="$HOME/.local/bin:$PATH"     # 写进 ~/.zshrc 或 ~/.bashrc
unitgen --help
```

也可以不改 PATH，直接用 `~/unitgen/bin/unitgen`。unitgen 直接运行 TypeScript 源码，没有构建步骤，所以这个目录要保留。

Windows 上在仓库目录执行 `npm ci`，然后用 `bin\unitgen.cmd`，也可以把 `bin` 加进 PATH。Windows 的 `UNITGEN_ENV` 是一个 `.cmd` 文件，用 `set JAVA_HOME=...` 这样的语句设置路径。

装好后在工程目录里运行 `unitgen doctor`，它会告诉你识别出的工程类型、用哪个运行器、缺什么。鸿蒙工程没执行 `ohpm install` 时，它会给出 DevEco 自带 ohpm 的完整路径。

## 使用

### 方式一：在 Claude Code 里用

安装 Skill：

```bash
mkdir -p ~/.claude/skills && ln -sfn ~/unitgen/skills/unitgen ~/.claude/skills/unitgen
```

然后在工程里对 Claude Code 说「用 unitgen 给这个工程补单测」，或者指定文件：「用 unitgen 给 `src/utils/url.ets` 补单测」。[Skill](skills/unitgen/SKILL.md) 里写了完整流程、每种结果怎么处理，以及几条规则：不改生产代码和构建文件，不弱化断言，期望值要从代码里读出来。做完会给出覆盖率前后对比、变异得分、疑似 bug 和没覆盖到的部分。

### 方式二：在 TRAE / TRAE CN 里用

TRAE 自己写测试，调用 unitgen 检查，不需要 Claude CLI 或 API Key。安装脚本（macOS/Linux）会装好 Skill，并把 CLI 链接到 `~/.local/bin`：

```bash
cd ~/unitgen && npm ci
sh scripts/install-trae.sh --project /absolute/path/to/your-project   # 装到工程的 .trae/skills/unitgen/
sh scripts/install-trae.sh --global                                   # 或装成 TRAE CN 全局技能 ~/.trae-cn/skills/unitgen/
```

TRAE 终端的 PATH 里要有 `~/.local/bin`（可以用 `UNITGEN_BIN_DIR` 换目录），或者在对话里给出 CLI 的绝对路径。工具链路径可以写在仓库外的环境文件里：

```bash
cp scripts/unitgen-env.example.sh ~/unitgen-env.sh    # 填写 Node、JAVA_HOME、ANDROID_HOME，不要提交
UNITGEN_ENV=~/unitgen-env.sh unitgen doctor -C /absolute/path/to/your-project
```

TRAE 每次调用工具都是新进程，上一条命令 `export` 的变量不会保留，所以每条命令都要带上 `UNITGEN_ENV`。任务可以这样写：

> 使用 unitgen 给当前工程补单测。先 doctor 和 baseline，基线成功后按 targets 和 brief 选逻辑文件，读取关联的数据类和测试替身的实现，生成测试，逐个 verify，再用 mutate 检查断言，最后输出 report。只新增测试，不改产品代码、已有测试和构建文件。报告里给出覆盖率的分子分母、变异测试评估了多少个，以及没有覆盖的部分。

Windows 上需要手动把 `skills/unitgen/` 整个复制到对应的 Skill 目录。

### 方式三：直接用命令行

```bash
cd <你的工程>                      # 在子目录里也行，unitgen 会向上找到工程根目录
unitgen doctor
unitgen baseline                   # 跑一次就行，代码大改后再跑
unitgen targets                    # 最值得补测试的文件排在前面
unitgen brief <源文件>             # 交给你用的模型，或者自己照着写
# 把测试写到 brief 指定的路径
unitgen verify <测试文件>          # --target <源文件> 可以省略，会按文件名推断
unitgen mutate <测试文件>          # 列出没被发现的变异，补上断言再跑
unitgen report                     # 生成 .unitgen/REPORT.md
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

不用 AI 编程助手，unitgen 自己调用模型，循环执行 brief → 写测试 → verify → mutate，并把失败信息反馈给模型：

```bash
unitgen generate --llm claude --limit 5       # 需要 PATH 里有 claude CLI
unitgen generate --llm anthropic --limit 5    # 需要 ANTHROPIC_API_KEY
unitgen generate --llm 'cmd:<从 stdin 读提示词、向 stdout 输出代码的命令>'
```

重试次数用完还不合格的文件会被移到 `.unitgen/rejected/`，命令返回 2。

## verify 的结果

| 结果 | 含义 | 怎么处理 |
|---|---|---|
| `ACCEPTED` | 通过全部检查，计入覆盖率 | 跑 `mutate` |
| `COMPILE_ERROR` | 测试编译不过，附编译器输出 | 按错误改测试 |
| `TEST_FAILURES` | 有测试失败，附断言差异；用到模拟实现的系统 API 时会标出来 | 重读代码改期望值；如果确实是代码的 bug，按现有行为断言，并加注释 `// UNITGEN-SUSPECT: 原因` |
| `FLAKY` | 第一次通过，重跑失败 | 去掉时间、顺序、共享状态这类不确定因素 |
| `NO_GAIN` | 都通过，但没有覆盖新的行 | 针对 brief 里标了 `!` 的行补测试 |
| `NO_ASSERTIONS` / `NO_TESTS` | 没有断言 / 一个测试都没跑 | 加断言；检查测试类名是否和 brief 一致 |
| `INFRA_ERROR` | 环境问题，比如缺 SDK、依赖没装、生产代码本身编译不过、拿不到覆盖率。不算尝试次数，已接受的文件不受影响 | 按提示修环境，或者换个目标 |

已接受的文件后来 verify 失败时，会暂时不计入覆盖率和报告，历史记录保留，再次通过后恢复。

## 变异测试

`mutate` 每次改动被测代码中已覆盖的一行，比如取反条件、改比较符、改常量、清空返回的字符串、删掉调用或赋值，然后重跑测试：

- killed：测试失败，说明断言发现了这个改动。因为异常、越界或死循环而失败的，单独记为「仅靠崩溃检出」。
- survived：代码改了，测试照样通过。输出里有变异编号（如 `[12.2]`）和改动后的那一行，补一条能让它失败的断言，`verify` 后再跑 `mutate`。
- 等价变异：改动不影响行为，比如一个之后一定会被覆盖的初始值。用 `unitgen mutate <测试文件> --equivalent 12.2` 排除，再用 `unitgen note "…"` 写明理由。只有通过模拟 API 才能看出区别的变异不算等价。
- 得分 = killed /（killed + survived）。编译不过的变异直接丢弃，不计分。默认要求 80%（`--min-score`）。
- 每次最多跑 `--max` 个变异（默认 15）。判定过的变异在测试文件改动前不会重跑，多跑几次就能把候选评估完。没评估完时，门禁结果会注明「on 19 of 71 candidates」，这时的得分只是抽样；加 `--require-all` 后抽样不算通过。报告里同时给出最近一次完整评估的得分。

单个变异的耗时大约是：hvigor 1–3 秒，SwiftPM/Gradle 3–10 秒，Xcode 20–40 秒（Xcode 建议 `--max 10`）。死循环的变异要等超时才算杀死（超时按已跑完的变异自适应，最少 20 秒），所以循环多的代码会慢一些。

## 各平台说明

鸿蒙

- 默认用 hvigor：按 DevEco 的本地单测流程在 Previewer 里运行，用真实的 ArkTS 编译器，覆盖率来自 hvigor 的 `coverageReport.json`。
- 用不了 hvigor 时，`doctor` 会说明原因，并改用 Node shim（也可以用 `UNITGEN_HARMONY_MODE=shim` 强制）。常见原因有：没跑 `ohpm install`、没声明 `@ohos/hypium`、`compileSdkVersion` 和本机 SDK 不一致、hvigor 插件锁了版本但没有 `~/.npmrc`。
- shim 用 TypeScript 转译 `.ets`，`@kit.*` / `@ohos.*` 全部是空实现，不跑 ArkTS 编译器，只适合纯逻辑。
- Previewer 里的系统 API 大多也是模拟实现。brief 会用 `!~` 标出调用这些 API 的未覆盖行，测它们周围的逻辑就好，不要断言它们的返回值。
- baseline 时会记下用的运行器，之后的 verify 和 mutate 必须用同一个。
- 测试或变异进入死循环时，unitgen 会停掉本工程卡住的 hvigor 守护进程和 Previewer，不影响其他工程。

iOS

- 只有 `Package.swift` 时用 SwiftPM，只有 `.xcodeproj` / `.xcworkspace` 时用 Xcode + iOS 模拟器。两者都有时默认 SwiftPM；要用模拟器（比如测 UIKit 代码），每条命令加 `--adapter xcode`。
- 用哪个测试框架以 brief 为准。`swift-tools-version` 低于 6.0 的包用 XCTest，因为它们 CI 里普通的 `swift test` 不跑 Swift Testing；部署目标低于 iOS 13 / macOS 10.15 的 Xcode 工程也用 XCTest。其他情况用 Swift Testing。
- Xcode 的构建产物放在 `.unitgen/DerivedData`，不影响你打开的 Xcode。unitgen 运行 xcodebuild 时会打开 `ENABLE_TESTABILITY`（`@testable import` 需要），并关掉老的 gcov 覆盖率开关（它们会让 llvm 覆盖率全为 0）。这些设置只对这次运行有效，不会改工程。

Android

- 自动找到每个模块的单测任务（包括 flavor），用 `-I` 注入 JaCoCo 初始化脚本，不改构建文件。
- 一个模块的测试跑到的其他模块代码，也会计入覆盖率。某个模块构建失败时（比如依赖要求更高的 compileSdk），基线照样测其他模块，并列出失败的模块和 Gradle 给的原因，这个模块的文件排在 `targets` 最后。
- 只支持 JVM 本地单测（`src/test`）。第一次构建要下载 Gradle 依赖，会比较慢。模块没有声明测试框架（JUnit / kotlin-test）时，brief 会提示换一个模块。

## unitgen 会改动哪些文件

| | 新增 | 修改 |
|---|---|---|
| 所有平台 | `.unitgen/`（状态、日志、REPORT.md，自带 `.gitignore`），建议加进工程的 `.gitignore` | — |
| 鸿蒙 | `<模块>/src/test/<文件>.unitgen.test.ets`；hvigor 生成的 `<模块>/.test/`（多数工程已经忽略 `**/.test`） | `<模块>/src/test/List.test.ets`，登记生成的测试，DevEco 里也能跑到 |
| iOS SwiftPM | `Tests/<Target>UnitGenTests/` | `Package.swift` 末尾加一段 `// unitgen:begin … // unitgen:end`（独立的测试 target） |
| iOS Xcode | 现有测试 target 里的 `<类>UnitGenTests.swift` | 需要时登记到 `project.pbxproj`（原文件备份在 `.unitgen/`） |
| Android | `src/test/<kotlin\|java>/<包路径>/<类>UnitGenTest.kt` | — |

生产代码、已有测试和构建配置不会被改。`mutate` 运行时会临时改动被测文件，结束后会还原；如果进程被强杀，下一条 unitgen 命令会负责还原。

撤销：`unitgen reject <测试文件> "原因"` 会把生成的测试移到 `.unitgen/rejected/` 并取消登记。手动删掉的生成测试，下次运行时会自动从 `List.test.ets` 里去掉。再删掉 SwiftPM 的标记块和 `.unitgen/`，就恢复原样了。

## 常见问题

**doctor 显示鸿蒙用的是 shim，不是 hvigor**

看 `runner:` 那一行给出的原因。最常见的是工程根目录还没执行 `ohpm install`，doctor 会给出 DevEco 自带 ohpm 的完整路径。

**工程原有的测试有失败，基线建不起来**

输出里会列出失败的用例。确认这些失败和你要做的事无关后，用 `unitgen baseline --allow-failing`，用其余通过的测试作为基线。

**verify 一直是 `INFRA_ERROR`**

看反馈里写的原因。常见的有：生产代码本身编译不过、ohpm 依赖没装、hypium 低于 1.0.19 导致拿不到覆盖率。hvigor 的覆盖率中间文件被中断的构建写坏时，unitgen 会删掉模块的 `.test/` 重新生成，再 verify 一次即可。这些都是环境问题，不要为了绕过去而改测试。

**提示 `project locked by a running unitgen command`**

同一个工程同一时间只能跑一条 unitgen 命令，等它结束或按提示停掉。上一条命令如果是被强杀的，下一条会自己确认、接管并还原改动过的文件；只有还有构建进程在跑时才会提示，并给出要执行的 kill 命令。不要手动删 `.unitgen/run.lock`。

**mutate 太慢**

用 `--max` 控制每次的数量，分几次跑完。Xcode 建议 `--max 10`。

**想看完整的构建输出**

在 `.unitgen/logs/` 里，每条命令结束时都会打印日志路径。

## 命令参考

```
unitgen <命令> [选项]

doctor                     识别工程类型，检查工具链
modules                    列出模块/target，以及生成的测试放在哪里
baseline                   跑原有测试和覆盖率             --allow-failing
targets                    按未覆盖逻辑给文件排序         --limit <n>（20）--all-kinds
brief <源文件>             生成写测试用的上下文           --out <文件> --feedback <文件>
verify <测试文件>          检查测试                       --target <源文件> --reruns <n>（1）--allow-no-gain --quarantine
mutate <测试文件>          变异测试                       --target <源文件> --max <n>（15）--min-score <百分比>（80）--require-all
                                                          --equivalent <编号|行号>[,...]（可重复）
generate                   无人值守                       --llm anthropic|claude|cmd:<sh> --model <id> --limit <n>（5）
                                                          --attempts <n>（3）--max <n> --min-score <百分比>
reject <测试文件> [原因]   隔离一个生成的测试
note <文字>                给报告加一条备注
report                     生成 .unitgen/REPORT.md
status                     基线、已接受、已隔离的数量

通用选项：-C <目录>（工程根目录，默认从当前目录向上找）  --adapter harmony|gradle|swiftpm|xcode
          --module <名称>  --json（结果输出到 stdout，进度在 stderr）
```

退出码：0 通过（或不适用变异测试）；1 命令、参数或环境错误；2 没通过质量门禁；130 被取消。

环境变量：

| 变量 | 作用 |
|---|---|
| `UNITGEN_HARMONY_MODE=hvigor\|shim` | 指定鸿蒙运行器 |
| `UNITGEN_HVIGOR_DAEMON=0` | hvigor 不用守护进程，每次冷启动（慢 3 倍左右） |
| `DEVECO_STUDIO_HOME` / `DEVECO_SDK_HOME` | DevEco 不在 `/Applications/DevEco-Studio.app` 时指定位置 |
| `UNITGEN_QUIET=1` | 终端不显示构建进度，日志照常写 |
| `UNITGEN_VERBOSE=1` | 打印执行的命令 |
| `UNITGEN_ENV=<env.sh>` | 只对 unitgen 进程生效的工具链环境文件。不设置时，如果 unitgen 目录旁边有 `unitgen-env/env.sh`，会自动使用 |

构建进度和诊断信息写到 stderr，`--json` 的结果写到 stdout，解析时不要把两者混在一起。用管道记录输出时，记得开 `pipefail`，否则拿不到 unitgen 的退出码。

## 开发

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # node --test
```

`UNITGEN_VERBOSE=1` 打印执行的命令；`UNITGEN_KEEP_COV=1` 保留 SwiftPM 的覆盖率 JSON，以及鸿蒙 shim 的转译结果和 V8 原始数据。实现细节见 [docs/DESIGN.md](docs/DESIGN.md)。
