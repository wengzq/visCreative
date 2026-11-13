# 0022 · Windows 支持

状态：已实现（2026-10-31）; Windows follow-up revalidation pending (2026-11-05)

日期：2026-10-31

## 背景

到目前为止只在 macOS 上开发和测试，Linux 只在 lockfile 里有原生包。维护者现在的开发机是 Windows 11，以后也要在 Windows 上发布。在一台干净的 Windows 机器上：

- `pnpm install` 失败：lockfile 只锁了 darwin-arm64 和 linux-x64 的原生包（rolldown、esbuild 等），vitest 启动就报找不到 binding；better-sqlite3 没拿到预编译包，退回本地编译，又没有 Visual Studio 构建工具。
- `pnpm build` 会失败：`apps/cli` 的 build 脚本用单引号传 `--banner:js`，Windows 上 pnpm 用 cmd.exe 执行脚本，不认单引号。
- studiod 监听 Unix socket（`run/studiod.sock`）。
- 密钥只能存 macOS 钥匙串（`/usr/bin/security`）。
- Agent 的密钥隔离靠 macOS `sandbox-exec`；没有沙箱时退回**只读模式**，Agent 在 Windows 上实际不能干活。
- 选目录用 `osascript`，「在文件管理器中显示」用 `open -R`，其他平台直接返回不支持。
- npm 全局装的 `codex`、`dsh` 在 Windows 上是 `.cmd` 包装脚本，`child_process.spawn` 不经 shell 不能启动 `.cmd`（Node 的安全限制）。
- 测试和 e2e 里写死了 `/tmp`、`/bin/sh`、shebang 脚本、POSIX 信号与文件权限。
- render provider 只找 macOS 和 Linux 的 Chrome 路径。

RFC 0021（节点组件）要在这台机器上开发和验证，所以本文先于 0021 实现。

## 目标

1. 在 Windows 11 x64 上，`pnpm install`、`pnpm check`、`pnpm build`、e2e 全量连续两遍通过，和 macOS 用同一份 lockfile。
2. 在 Windows 上能完整使用：studiod、网页界面、Codex / DeepSeek Harness / Claude 会话、生成、本地媒体处理。
3. macOS 的行为和安全保证不变。
4. Windows 上的安全差异写清楚，并在用户配置密钥之前提醒。

## 不做

- Windows 上的 Agent 进程隔离（AppContainer、低权限账户等）。另开课题。
- 安装包、开机自启、桌面应用。
- Windows on ARM、32 位。
- Linux 的完整支持（顺带受益的部分保留，但不是验收标准）。

## 决定

### 1. 依赖与工具链

- `pnpm-workspace.yaml` 加 `supportedArchitectures`，os 为 `darwin`、`linux`、`win32`，cpu 为 `x64`、`arm64`。重新生成 lockfile（只新增平台包，不升级任何依赖）。
- better-sqlite3：13.x 的四个版本都没有发布 Windows 预编译包（`node-v137-win32-x64` 返回 404，12.12.0 有）。维护者 2026-10-31 选定**不改依赖**，Windows 上本地编译：README 写明先安装「Visual Studio 构建工具 · 使用 C++ 的桌面开发」（`winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`）。将来发布 Windows 安装包时再决定是否依赖预编译包。不换 SQLite 驱动。
- `package.json` 脚本里的引号、`rm`、`cp`、环境变量写法改成跨平台写法；必要的改成 `node scripts/*.mjs`。不引入 `cross-env`、`rimraf` 之类的新依赖。
- 新增 `.gitattributes`：`* text=auto eol=lf`，二进制素材标 `binary`。Windows 上 `core.autocrlf=true` 会把检出的文件变成 CRLF，可能影响快照测试和 shebang。
- ffmpeg / ffprobe：README 写明 `winget install Gyan.FFmpeg`。缺失时沿用现有的「找不到 ffmpeg」错误。

工具链实施：保留现有依赖版本，用 `pnpm install --lockfile-only --fix-lockfile` 补全 rolldown 平台包；保留原有 deprecated 元数据，使 lockfile 差异只有新增项。CLI banner 使用双引号，studiod 构建素材由 `scripts/copy-studiod-assets.mjs` 复制；工具脚本用 `fileURLToPath` 解析仓库目录。`.gitattributes` 已加入，维护者执行 renormalize 后无内容变化。

### 2. 进程间通信

- 新增 `studiodEndpoint(dataDir)`：macOS、Linux 返回 `run/studiod.sock`；Windows 返回命名管道 `\\.\pipe\vis-studiod-<hash>`，`hash` 取规范化后 `dataDir` 的 sha256 前 16 位，这样不同的数据目录（开发、e2e 的隔离目录）不会冲突。
- studiod、`vis` CLI、devcli、web host 都改用这个函数，不再自己拼 `.sock` 路径。
- Windows 上不 `chmod`。命名管道默认只允许当前用户和管理员访问；连接后的令牌鉴权（0004）不变，所以访问控制不依赖文件权限。
- 旧 socket 的清理（`claimSocket`）只在非 Windows 上执行；Windows 上管道被占用就报「studiod 已在运行」。

运行时实施：共用函数放在 `runtime/studiod-endpoint.ts`，由各 Node 入口直接打包；现有依赖图没有可供 CLI、devcli、web host 和 studiod 共用的非协议包，因此不把 IO 工具塞进 protocol，也不新增包或依赖。Windows 对已有父目录取 realpath、补回尚未建立的子目录并统一小写后散列；CLI 的显式 `VIS_SOCKET` 优先，缺省可从 `VIS_DATA_DIR` 推导地址。服务端保留令牌鉴权和单实例锁。

### 3. 密钥存储：Windows 凭据管理器

- `secret-store.ts` 按平台选择实现：macOS 用钥匙串（不变），Windows 用新的 `createWindowsCredentialStore`，其他平台保持报错。
- 实现方式：调用 `powershell.exe -NoProfile -NonInteractive -Command -`，**脚本和密钥都从 stdin 传入**，不出现在命令行参数里（命令行参数能被同用户的其他进程看到）。脚本使用系统自带的 WinRT `Windows.Security.Credentials.PasswordVault`，不新增依赖，也不需要额外的 PowerShell 模块。
  - resource 为 `vis-creative.provider`，userName 为 providerId，和钥匙串的 service / account 一一对应。
  - get、set、delete、has 四个操作与钥匙串版本的语义一致；找不到时 get 返回 undefined，has 返回 false。
  - 输出只有约定的结果，PowerShell 的错误流丢弃，不进日志，避免把密钥带出来。
- 测试规则不变：只用 `vis-creative.provider.test`，在 `finally` 里删除；不读真实的 `vis-creative.provider`。
- AGENTS.md 的「密钥只存在 macOS 钥匙串」改为「密钥只存在系统凭据库：macOS 钥匙串或 Windows 凭据管理器」。读写规则同样写进去。

### 4. Agent 隔离：Windows 上较弱，事先提醒

> Note ([RFC 0048](0048-agent-native-capabilities.md), 2026-11-12): Agents keep their own web search and fetch. Codex runs with live web search, so OpenAI's servers fetch the pages it opens; in `auto` approval an Agent's own read-only web search and fetch pass without asking. This widens no secret, cost or gateway limit, on Windows or elsewhere.

macOS 上 `sandbox-exec` 阻止 Agent 读取密钥、studiod 令牌和数据库文件。Windows 没有现成的等价物，本期**承认这一点**（维护者 2026-10-31 确认）：

- Windows 上 Agent 以当前用户身份运行，**不加沙箱，也不退回只读模式**。技术上它能读到凭据管理器、`run/` 下的令牌和数据库文件。
- 仍然生效的保护：
  - gateway 按调用方和工作项关系检查权限（不依赖沙箱）；
  - 传给 Agent 的环境变量仍按白名单过滤，不传密钥；
  - Agent 的提示词和工具输出里仍然不出现密钥；
  - 0015 的 `auto` 审批模式仍然只自动批准工作目录内的命令和写入，其余都要用户批准。这是 Windows 上的主要防线。
- `sandbox.ts`：`prepareSandbox` 在 Windows 上返回 `{ env, policy: undefined, notice: undefined, isolation: 'none' }`，**不再退回只读**。macOS 上缺少沙箱时退回只读的行为不变。
- 环境变量白名单补上 Windows 必需的变量：`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`SystemRoot`、`ComSpec`、`PATHEXT`、`TEMP`、`TMP`。缺少这些变量时，Node、PowerShell 和 Git 都会出问题。
- **事先提醒**（不做 mock 默认值，也不需要额外确认）：
  - 设置 › 生成服务：在 Windows 上，密钥输入框上方常驻一条提示：「Windows 上 Agent 没有隔离沙箱，理论上能读取本机保存的 API Key。只在信任的项目里使用 Agent。」
  - 设置 › 通用 › 安全与额度：同样的说明。
  - 文案放在 `messages.ts`，中英文都有。隔离方式从 `providers.list` 的结果里取：新增 `agentIsolation: 'sandbox' | 'none'`（浏览器拿不到 `runtime.hello` 的结果，握手由 web 宿主代做）。
- README 的安全部分写清楚两个平台的区别。

### 5. 启动 Agent 与命令行工具

- 新增 `resolveExecutable(name, explicitPath?)`（`workbench/core`）：
  - Windows 上依次查 `PATH` 和 `PATHEXT`。找到的是 npm 生成的 `.cmd` 包装脚本时，解析出它调用的 JS 入口，用 `process.execPath` 启动；找到 `.exe` 就直接启动。
  - **不使用 `shell: true`**，避免参数被 cmd.exe 二次解析（提示词里的 `&`、`|`、`%` 等字符）。
  - macOS、Linux 上行为不变。
- Codex：沿用 `codexPath` 或 PATH 里的 `codex`，经 `resolveExecutable` 解析。
- DeepSeek Harness：`resolve-dsh.ts` 已经会在 node_modules 里找 `@deepseek-ai/dsh`，补上 Windows 的 `.cmd` 和 `node_modules/.bin/dsh.cmd`，同样解析到 JS 入口。（维护者已确认 dsh 有 Windows 版：`npx @deepseek-ai/dsh web`。）
- Agent 在 shell 里调用的 `vis`：Windows 上 studiod 启动时，在 `cliBinDir` 旁的运行目录里生成 `vis.cmd`，内容是用当前 `process.execPath` 的绝对路径运行 `vis.mjs`。node 的安装位置不固定，所以不在构建时写死。PATH 拼接统一用 `path.delimiter`。
- Claude：Agent SDK 本身支持 Windows，只检查 PATH 和环境变量的处理。

Agent 实施：`resolveExecutable` 返回 `{ command, args }`，Windows 上把 npm `.cmd` 的 `%~dp0` / `%dp0%` JavaScript 入口和直接指定的 `.js` / `.mjs` 交给当前 Node，拒绝无法识别的批处理脚本，不使用 shell。dsh 同时查 PATH、显式 npm cache、Windows `LOCALAPPDATA/npm-cache` 和原有 `~/.npm` 缓存。Codex/dsh 新增可选 `cliBinDir`，由 studiod 传入生成 `vis.cmd` 的目录；Claude 沿用同名必填参数，三个适配器均使用 `path.delimiter`。

Windows 的「不退回只读」同时作用于 Codex 线程配置、dsh overlay 和审批转发；没有 Seatbelt 时不宣称存在隔离。macOS/Linux 的只读回退保留。设置根据服务端 `agentIsolation` 显示双语常驻提醒，缺少字段时不自行推断平台。

studiod 的 `prepareAgentCli(dataDir, cliBinDir, sourceEnv?)` 返回 `{ cliBinDir, env }`：Windows 入口位于 `<dataDir>/run/cli/vis.cmd`，以绝对 Node 路径运行原构建目录中的 `vis.mjs`，该目录在 `env.PATH` 最前。三个 studiod runtime 工厂通过既有适配器 `env` 选项传递环境，Claude 同时接收返回的 `cliBinDir`；适配器仍负责白名单过滤。Codex/DeepSeek 工厂新增显式 `dataDir`，因为不能从命名管道地址反推数据目录。

### 6. 文件系统交互

- 选择目录：Windows 上用 `powershell.exe` 调用 `System.Windows.Forms.FolderBrowserDialog`（脚本从 stdin 传入，开 STA 线程），返回选择的路径。取消时返回 `cancelled: true`。
- 在文件管理器中显示：Windows 上用 `explorer.exe /select,<path>`。
- 路径比较统一用 `path.relative` 和 `path.sep`，不手写 `/`。Windows 上不区分大小写，路径包含关系检查前先统一大小写（`canonical()` 在 win32 上转小写后再比较）。这关系到 0015 的 `auto` 审批，属于安全相关，要专门写测试。

自动审批实施：在处理每一个 `.` / `..` 之前先解析此前路径，避免 Windows `realpath` 预先折叠 junction 后面的 `..`。不存在的目标逐级检查父路径，断链、循环和非目录父路径保持询问；已有路径通过 native realpath 展开 8.3 别名，统一长路径前缀，最终包含关系比较时忽略大小写。测试覆盖混合分隔符、大小写、`\\?\`、8.3 别名及 junction 穿越。文件系统检查不能消除检查后链接被其他进程替换的竞态，自动审批不等于 OS 沙箱。

### 7. render provider

- Chrome 默认路径补上 Windows：`%ProgramFiles%\Google\Chrome\Application\chrome.exe`、`%ProgramFiles(x86)%\...`、`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`，再加上 Edge（`msedge.exe`，同样是 Chromium）。

### 8. 测试与 e2e

- 测试里的 `/tmp` 改成 `os.tmpdir()`，`/bin/sh` 和 shebang 脚本改成 `process.execPath` + `.mjs`。
- e2e 的 `VIS_CODEX_PATH` 指向 `fake-codex.mjs`，在 Windows 上不能直接执行：`resolveExecutable` 遇到 `.mjs`/`.js` 时用 `process.execPath` 启动。
- 依赖 POSIX 信号的测试：Windows 上 `SIGTERM` 等同于强制结束，测试只断言「进程已退出」，不断言退出信号。
- 只适用于某个平台的测试用 `it.runIf(process.platform === 'darwin')`，并在测试名里写明平台。不能为了通过而跳过安全相关的断言：沙箱策略测试只在 macOS 跑，Windows 的凭据存储和路径包含测试只在 Windows 跑。
- 截图和临时报告放在 `os.tmpdir()` 下，不放 `/tmp`。

测试实施：假的 RPC 服务在 Windows 上用独立命名管道；真实 studiod 的集成测试保留运行时失败，不跳过。浏览器 e2e 支持 `VIS_CHROME_PATH`，Windows 默认查找 Chrome / Edge，macOS 保留原有 Chrome 路径。目录链接测试在 Windows 使用 junction；文件符号链接仍需宿主权限，权限不足时保留失败，不跳过安全断言。POSIX mode 位单独测试，内容、路径边界和导入行为继续跨平台验证。macOS 沙箱集成测试保留短 `/tmp` 路径，避免 Unix socket 长度限制。

Ark 幂等记录：Windows 全量并发测试确认替换记录的 `rename` 会短暂返回 `EPERM`。仅对 Windows 的该错误进行有上限的退避重试（10–640ms，共七次等待），保留原 `submitting` 文件，绝不先删除目标或重试 HTTP 提交；持续失败仍返回结果未知。并发测试继续要求只请求一次，并验证新实例可读取已保存结果。

## 验收

在 Windows 11 x64（Node 24）上：

- `pnpm install --frozen-lockfile` 不需要额外参数就成功（better-sqlite3 能拿到预编译包，或者 README 写明的构建工具已装好）；
- `pnpm check` 全部通过；
- `pnpm build` 之后，e2e 全量连续两遍通过；
- 手动检查：启动 `pnpm dev:studiod && pnpm dev:web`，新建项目、选目录、上传素材、mock 生成、Codex 会话一轮、在设置里写入和清除一个测试密钥，提醒文案正确显示。

在 macOS 上，维护者有机会时做一次回归：`pnpm check`、e2e 一遍、钥匙串读写测试。

## 并行拆分

| Worker | 范围 |
|---|---|
| W1 工具链与测试 | `pnpm-workspace.yaml`、lockfile、`.gitattributes`、各 `package.json` 脚本、`scripts/`、所有测试文件与 e2e 里的路径和平台写法 |
| W2 运行时 | `services/studiod`（通信地址、密钥存储、文件系统、`runtime.hello`）、`apps/cli`、`apps/devcli`、`apps/web/src/host`、render provider |
| W3 Agent 启动 | `packages/workbench/*`（`resolveExecutable`、沙箱与环境变量、dsh 解析）、设置里的提醒文案与 UI |

W1 先做，否则其他人跑不了测试；W2、W3 在 W1 的工具链提交之后开始，可以并行。协议只在 `providers.list` 的结果里加 `agentIsolation`，由 Claude 先提交。

## 实现时的补充

- **验收结果**（2026-10-31，Windows 11 x64、Node 24，沙箱外）：`pnpm check` 1288 通过、10 个按平台跳过；`pnpm build` 通过；浏览器 e2e 连续两轮 135 通过、1 个跳过（POSIX 执行位）。
- **开发环境前提**：Visual Studio 构建工具（better-sqlite3 13.x 没有 Windows 预编译包）、ffmpeg、开发者模式（否则普通用户不能创建文件符号链接，6 个拒绝符号链接的安全测试无法运行）。
- **自动审批的 junction 漏洞**：Windows 上 `realpath` 会先消除 `..`，借 junction 加 `..` 能让工作目录外的写入被自动批准。改为逐段解析：`..` 只在前面的路径解析完之后处理，悬空和循环链接保持询问，比较时忽略大小写并去掉 `\?\` 前缀。
- **方舟提交记录**：Windows 上并发替换记录文件时 `rename` 偶发 `EPERM`。只对这个错误有限次重试文件替换，不重发付费的 HTTP 提交。
- **SQLite 句柄**：打开或迁移失败时关闭连接，否则 Windows 上文件被锁、目录删不掉。
- **通信地址**：`studiodEndpoint` 放在仓库根的 `runtime/studiod-endpoint.ts`，由各入口按相对路径引用、打包进产物。CLI、devcli 只能依赖 protocol，web 宿主不能依赖 storage，没有合适的共享包；以后若新增运行时工具包再迁过去。
- **e2e**：合成的按键按下事件要配对发出抬起事件，否则 React Flow 认为修饰键一直按着（macOS 上按 Meta 会顺带清掉，Windows 上不会）；多选用 `ControlOrMeta`；路径断言按平台分隔符或 JSON 编码比较。
- **后续加固（未做）**：Windows 上 Codex 线程目前用 `danger-full-access`。Codex 自带的 Windows 沙箱可以把写入限制在工作目录内，可作为单独一项评估（代价是部分工具可能遇到权限错误）。

## Validation follow-up (2026-11-05)

Status: implementation fixes prepared on macOS; Windows stability acceptance remains open. Unit concurrency is capped at four workers on Windows to avoid one browser/ffmpeg/SQLite fixture per logical CPU on the 16 GiB validation host. The 30-second Chrome teardown budget is unchanged; resource pressure is a candidate cause, not a proven diagnosis. The stream-probing integration case launches fourteen ffmpeg/ffprobe processes, and the series caller case makes dozens of real RPCs across three clients and two disk-backed projects; each has a Windows-only 20-second budget, matching the existing CI allowance. Assertions remain intact. ffprobe uses execFile's close callback and runMedia waits for `close`, so no early process-release path was found there. The reported media-directory EPERM may follow test timeout, but requires a Windows rerun to establish the cause. See known issues for exact reruns.
