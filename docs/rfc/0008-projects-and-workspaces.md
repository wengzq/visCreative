# 0008 · 项目、工作区与项目技能

状态：已实现（本地模式）

日期：2026-10-27

补充 [0001](0001-multi-agent-creative-space.md)、[0002](0002-sqlite-storage.md)、[0004](0004-runtime-and-agent-entry.md)、[0005](0005-agent-adapters-and-mcp.md) 和 [0006](0006-web-ui.md)。项目是界面中对现有 Space 的称呼，继续使用 `spaceId`、`space.*`，不新建一套项目身份。

## 数据与目录归属

每个项目持久保存绝对路径 `rootPath`。默认位置为 `$VIS_PROJECTS_DIR/<项目名>`；没有设置环境变量时为 `~/visCreative/<项目名>`。创建时也可指定绝对路径，项目名用于默认目录名时会清理路径分隔符；不把项目名当成任意路径执行。

```text
<项目 rootPath>/
├─ assets/                    项目共享的本地素材文件
├─ skills/<skill>/SKILL.md     项目技能，按下一层目录发现
└─ workspaces/<目录名>/        默认会话工作目录

<应用数据目录>/
├─ app.db                     项目目录登记与全局配置
└─ spaces/<spaceId>/
   ├─ space.db                画布、会话、消息、任务等业务真源
   ├─ blobs/                  内容寻址且不可变的已登记素材
   └─ agents/                 适配器管理的运行配置
```

延续 0002：只有 studiod 打开数据库；画布内容、修订、快照、回填和幂等仍由 SQLite 保证。项目目录不是第二份可直接编辑的画布真源。`assets/` 是共享本地文件目录和受控导入边界；素材登记后仍存入 `blobs/`，本轮不迁移既有 blob，也不自动把全部画布素材镜像到项目目录。

旧项目没有 `rootPath` 时回填为 `<应用数据目录>/spaces/<spaceId>/project`，建立上述三个子目录；不把旧数据迁到用户主目录。旧会话没有 `workDir` 时回填并保留原来的 `<空间数据目录>/sessions/<sessionId>`，避免改变原生 Agent 的 resume 目录。

## 会话与工作区

每个会话保存自己的 `SessionSummary.workDir` 绝对路径；用户明确选择时允许多个会话共用已有目录。新建会话可采用项目下的默认目录，或选择一个已有、可读写的本机目录。默认目录由非空标题生成安全名称，冲突时追加会话 ID 后八位；空标题使用 `ws-<会话 ID 后八位>`。目录在创建时验证，后续启动或恢复再次检查；目录被移走或权限变化时明确失败，不悄悄切换 cwd 或重建一个空目录恢复原生会话。

创建对话框提供 Codex、DeepSeek、可选标题与工作目录；标题留空使用 Agent 种类与编号的默认名字，并保留 `titleSource: default`，供 Agent 在理解创作后命名。用户填写标题时来源为 user，Agent 不覆盖。创建后可以继续创建更多会话。新增工作目录选择不会放宽现有工具和沙箱权限。

切换项目同步切换画布与会话集合，当前项目 ID 保存在浏览器 `localStorage` 的 `vis.project`。切换项目和收起会话面板都不停止后台回合或生成任务；RPC 订阅仍按空间隔离。项目入口打开共享 `assets/`，会话入口打开持久工作目录。

## 本机文件系统入口

以下方法仅允许 UI 身份调用，不暴露给 Agent：

| 方法 | 参数与返回 | 规则 |
|---|---|---|
| `fs.pickDirectory` | 可选 `defaultPath`；返回可选 `path`、`cancelled`、`unsupported` | macOS 使用系统目录选择器；不支持时允许手动填写绝对路径；取消不当作错误 |
| `fs.validateDirectory` | `{ path }` → `{ valid, error? }` | 检查绝对路径、目录存在及可读写性，不自动创建已有目录 |
| `fs.listSkills` | 可选 `spaceId` → `{ skills: [{ name, description, path }] }` | 指定项目或当前订阅项目的技能目录 |
| `fs.reveal` | `spaceId` 或 `sessionId`，二选一 | 项目打开 `assets/`，会话打开 `workDir`；由后台解析已登记目录，不接受任意路径；返回 `path` 与 `revealed` 供不支持的平台展示 |

浏览器不直接访问任意本地路径，仍由网页宿主鉴权、转发到 studiod。`VIS_PICK_DIRECTORY` 用于自动化测试目录选择成功或取消；测试项目根及已有目录均放在临时目录，不写 `~/visCreative`。

## 技能发现与显式选择

项目技能来自 `<rootPath>/skills/<目录>/SKILL.md`，不递归扫描任意会话工作目录。从文件夹、压缩包或其他项目导入 skill，以及移除 skill，见 [0017](0017-skill-import.md)。目录只保存 `name`、`description` 和绝对 `SKILL.md` 路径，不把完整技能正文复制进每条消息。模型依据任务按需读取正文及其相对资源，再遵循技能流程。

会话输入区提供技能选择与 `/` 名称筛选；选中项显示为可移除的标签。`session.sendMessage.skills` 保存技能**名称**数组，与消息及用户 transcript 一同持久化；重试保留同一选择。服务端从项目技能目录核对名称，模型不能通过这组参数指定任意本地路径。

每个回合重新组装：

- `<项目>`：项目根目录、素材目录、会话工作目录、技能目录及当前技能名称、描述、`SKILL.md` 路径；说明按需读取。
- `<指定 skill>`：用户在本条消息明确选择的名称及目录中对应的完整路径；要求开始相关工作前必须读取并遵循各自的 `SKILL.md`。
- 原有 `<会话>` 与 `<引用>`：Codex、DeepSeek 的命名规则保持不变；画布引用继续使用本回合固定快照。

技能目录是当前磁盘状态，尚未冻结技能正文版本；不把技能文件读取等同于 0001 的素材输入快照。技能不能增加运行令牌权限，也不能绕过修订、路径或工具校验。

## 原生 Agent 技能接入与证据

2026-10-27 核对本机实际安装版本，而不是只按最新文档推断：

| 适配器 | 已核实原生入口 | 当前接入 |
|---|---|---|
| Codex CLI **0.164.0** | 本机 `codex app-server generate-json-schema` 包含 `skills/extraRoots/set`，参数 `{ extraRoots: string[] }`；`turn/start.input` 支持 `{ type: 'skill', name, path }` | 完成握手后、开启或恢复线程前，把项目 `skills/` 作为该进程的额外根；明确选择同时作为原生 skill 输入。旧版本明确返回方法不存在时仍依赖回合中的目录与路径提示，不写用户全局配置 |
| DeepSeek Harness **0.2.1-rc.2** | 本机缓存包 `@deepseek-ai/dsh-skill-filesystem` 的 `Config.customSkillDirs` 与 `FileSystemSkillProvider`；ACP profile 挂载该插件 | 项目回合在独立会话 overlay 中设置 `includeDefaultRoots: false` 和 `customSkillDirs: [项目 skills 目录]`，不在用户目录创建技能链接 |
| Claude SDK **0.3.310** | 本轮未验证项目技能原生发现 | 仍通过每回合目录元数据与明确读取要求接入；保留 `settingSources: []`，不加载用户设置来改变权限 |

Codex 的无模型探针在临时目录创建技能，经真实 `app-server` 调用 `initialize`、`skills/extraRoots/set`、`skills/list(forceReload: true)`，返回了该技能的名称、描述和真实文件路径。DeepSeek 的无模型探针调用上述已安装 `FileSystemSkillProvider`，用同样的临时目录发现技能并读出正文；`dsh --profile acp --dump-config` 确认 ACP profile 的插件挂载。两者都没有发送模型请求，不能据此声称模型已完成技能创作任务。

OpenAI 官方说明同样采用先提供技能元数据、再按需读取正文的方式，参见 [Build skills](https://learn.chatgpt.com/docs/build-skills)。具体 RPC 兼容性以已安装版本生成的 schema 与本机探针为依据。

DeepSeek 环境规则改由 overlay 的 `system-prompt.personaSuffix` 注入。这个字段已在同版本 `dsh-system-prompt` 类型和实现中确认；不再创建或覆盖工作目录中的 `AGENTS.md`，用户现有说明文件保留原样。overlay 保存在应用数据目录中，并按会话区分，避免多个 cwd 的配置互相覆盖。

## 本地媒体登记与画布交付

新增仅活动 Agent 可调用的 `asset.importFile`，MCP 名为 `asset_import_file`，CLI 为 `vis asset import file`。参数 `{ requestId, path, displayName? }`，返回既有 `AssetVersionView`；与 `asset.import` 共用探测、内容寻址存储与事务登记，不直接创建画布节点。

后台先要求绝对路径，以 `realpath` 解析源文件和允许目录，再检查源文件位于当前会话 `workDir` 或项目 `assets/` 内。拒绝目录、越界路径及符号链接逃逸，文件上限为 2 GiB；沿用媒体探测，只接受支持的图片或视频。

Agent 自己获得的本地媒体须先登记，再通过 `canvas.apply` 创建节点或填入已有槽位；覆盖槽位仍带 `expectedRevision`。只生成文件、输出文件路径或登记素材都不等于画布交付。`generation.submit` 的产物继续自动登记和回填，不需要重复导入。

这项能力只增加受控的文件登记，不自行授予 shell 或文件写权限。后续 N2（RFC 0005）让 Codex 在外层 Seatbelt 内获得会话 workDir 写入、命令和网络权限，并接入聊天审批；任务 D 让 DeepSeek 复用同一外层 Seatbelt，经真实隔离探针通过后开放 shell/写文件/联网，Claude 保持既有允许列表。执行不确定时仍复用原 requestId 核对回执，不自动创建新的收费任务。

## 验证边界

适配器及提示词测试覆盖项目目录、完整技能目录元数据、显式名称解析、原文与固定引用保留、Codex 原生根和指定 skill 输入、旧版接口回退、DeepSeek 原生根配置与现有 `AGENTS.md` 原字节保留。项目、工作目录迁移、文件校验和 UI 流程由对应服务测试及浏览器 E2E 覆盖；E2E 使用假的 Codex 进程检验实际 cwd 和发出的 prompt，不冒充真实模型验收。

项目工作区功能不提供跨机器工程搬迁、自动修复被移动的工作目录、全盘技能扫描或技能正文版本锁定；工具审批界面由 N2 提供。


任务 D 的 dsh 自动定位支持 VIS_DSH_PATH、PATH 和 npx 缓存最高版本，无需全局安装。真实会话继续使用持久化 workDir；工作区内写入成功，工作区外写入被拒，素材读取与 vis canvas_get 均成功。外层沙箱允许 ~/.dsh 配置目录读写（含自身凭据，Agent shell 也可读），不允许写整个 ~/.npm 缓存；应用不打开凭据文件。无可用隔离时保留只读工具并提示。overlay 无论有无项目技能都按会话生成，避免并发读写模式互相覆盖；不改用户 AGENTS.md。完整隔离和审批边界见 RFC 0005 的任务 D 实测。
