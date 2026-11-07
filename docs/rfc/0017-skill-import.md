# 0017 · 导入与管理项目 Skill

状态：已实现（2026-10-30）；全局作者库由 RFC 0033 第 a 步扩展（2026-11-05）; Windows follow-up revalidation pending (2026-11-05)

日期：2026-10-30

基于 [0008](0008-projects-and-workspaces.md)（项目 skill 的发现与显式选择）与 [0015](0015-session-experience.md)（输入框的 Skill 入口）。来源：维护者 2026-10-29 体验问题清单「基础：导入 skill」。

## 背景

0008 起，项目 skill 来自 `<rootPath>/skills/<目录>/SKILL.md`：studiod 每回合列出名称、描述和路径，Codex、DeepSeek 原生接入，输入框可以用 `/` 或「＋ Skill」指定。但把一个 skill 放进项目，只能自己在访达里复制目录：

- 不知道该放哪、放对没有；frontmatter 写错的目录会被静默跳过。
- 网上下载的 skill 多是压缩包，或一个仓库里装了好几个 skill。
- 想把 A 项目调好的 skill 用到 B 项目，只能手动找目录。
- 不用的 skill 没有地方移除。

## 决定

### 1. 范围：仍然按项目

本 RFC 的导入目标仍是项目的 `skills/` 目录。[RFC 0033](0033-author-skill-library.md) 第 a 步另增作者库、按请求起草和编辑保存，以及明确使用后复制到项目的固定副本；本节原先不做全局库的决定已被修订。导入就是把内容**复制**进这个目录（不建链接），之后和用户手动放进去的 skill 完全一样，Agent 侧发现与指定流程（0008）不变。

### 2. 三种来源

| 来源 | 界面入口 | 后台 |
|---|---|---|
| 本机文件夹 | 「从文件夹…」，系统目录选择器（`fs.pickDirectory`） | `skill.stage { path }` |
| 压缩包 `.zip` / `.skill` | 「从压缩包…」，浏览器文件选择；也可以把压缩包拖进 Skill 管理窗口 | 网页宿主 `/upload?kind=skill` 收到文件后调 `skill.stage { path }`，回执前删掉临时文件 |
| 其他项目 | 「从其他项目…」，先选项目，再勾选它的 skill | `skill.stage { fromSpaceId, names }` |

不做从网址或 Git 仓库导入（要联网，来源不可控；以后需要再单独设计）。也不扫描 `~/.codex`、`~/.dsh`、`~/.claude` 等 Agent 自己的目录。

### 3. 先暂存，确认后再导入

导入分两步，用户确认的就是最终写入的内容：

1. **`skill.stage`**：把来源复制或解压进暂存区 `<应用数据目录>/spaces/<spaceId>/skill-staging/<stagingId>/`，校验并找出其中的 skill，返回候选列表。暂存区不在项目目录里，Agent 的工具看不到它，也写不了。
2. **`skill.import { stagingId, names, replace? }`**：把勾选的候选从暂存区移进项目 `skills/`，然后删掉整个暂存区。`skill.discard` 丢弃暂存区；超过 1 小时未处理的暂存区和 studiod 启动时残留的暂存区自动清掉。

**找 skill 的规则**：在来源里找 `SKILL.md`，最多向下 3 层；一个 `SKILL.md` 所在的目录就是一个候选，候选目录里面的 `SKILL.md` 不再单独算。所以下面几种都能识别：

- 选中的就是 skill 目录（根下有 `SKILL.md`）；
- 压缩包外面包了一层同名目录；
- 一个仓库或文件夹里装了好几个 skill（例如 `skills/<名称>/SKILL.md`），用户勾选要哪些。

每个候选必须有 frontmatter 的 `name` 和 `description`，解析规则与现有 `listProjectSkills` 共用同一个函数。不合格的目录放进 `skipped`，附原因（「缺少 SKILL.md 的 name」「名称不能用作目录名」等），界面照常展示。

**导入后的目录名**取 frontmatter 的 `name`：必须是合法的单层目录名（不含 `/`、`\`、`:`、控制字符，不是 `.` 或 `..`，不以 `.` 开头，最长 64 个字符）。中文名允许。

### 4. 安全与限额

导入的 skill 是不可信内容：它的说明会进入 Agent 的上下文，脚本可能被 Agent 执行。导入本身**从不执行**其中任何文件；运行时仍受审批模式、沙箱与路径校验约束（0005、0015），skill 不增加任何权限（0008）。

暂存时检查：

- 单次来源合计不超过 **512 MiB**、**10000** 个文件，目录深度不超过 16 层，候选不超过 100 个。压缩包会整体读进内存解析，所以文件本身先限制在 256 MiB 以内；ZIP64 和非 UTF-8 文件名直接拒绝。（2026-11-05 raised from 50 MiB, 2000 files and 64 MiB after a real skill with an SDK hit the archive limit.）
- **拒绝符号链接和特殊文件**（设备、FIFO、套接字），错误信息指明路径；符号链接不跟随。
- 压缩包：自己解析 zip 的中央目录（只支持 stored 和 deflate，不加新依赖），解压前按条目声明的大小检查限额，解压时按实际字节数再卡一次，防止压缩炸弹；条目路径不能是绝对路径、不能含 `..`、不能在归一化后重名；条目若被标为符号链接则拒绝。加密的 zip 直接报错。
- 跳过 `.git/`、`__MACOSX/`、`.DS_Store`，不计入限额。
- 每个候选返回文件数、字节数，以及「脚本或带可执行位」的文件列表（扩展名 `.sh .bash .zsh .py .js .mjs .cjs .ts .rb .pl .ps1 .bat .cmd` 或有执行位）。界面据此提示「含脚本」，**只是提示，不拦截**。
- 写入项目时保留文件的执行位，其余权限按默认值。

### 5. 同名与替换

候选的 `exists` 表示项目里已有同名 skill（按 frontmatter 名称），或已有同名目录。

- 默认不替换：`replace` 不为真时导入同名候选返回 `invalid_params`，整次导入不写任何东西。
- 用户勾选「替换」后：旧目录先移到已移除目录（见 6），再把新目录放进来。
- 写入时先放进 `skills/.importing-<id>/`，完整后再改名成目标目录，避免 Agent 读到写到一半的 skill。`listProjectSkills` 跳过以 `.` 开头的目录。

### 6. 移除

`skill.remove { name }` 把这个 skill 的目录**移到** `<应用数据目录>/spaces/<spaceId>/removed-skills/<目录名>-<时间戳>/`，返回新位置，界面提示可以从这里找回。不做自动清理（与附件副本的决定一致）。项目被永久删除时，这个目录随应用数据一起删除。

跨磁盘时（项目目录和应用数据目录在不同卷上）改成先复制、再删除源目录。

### 7. 列表与问题目录

`skill.list` 返回 `skillsPath`、有效 skill，以及 `problems`：`skills/` 下一层里无法识别的目录和原因。原来静默跳过的情况都列出来，包括没有 `SKILL.md`、frontmatter 缺字段、名称重复、`SKILL.md` 是指向目录外的链接。`fs.listSkills` 保留不变，继续给输入框的选择器用。

skill 目录不在 SQLite 里，也没有事件。界面在打开 Skill 选择器、打开管理窗口，以及导入或移除完成后重新读取列表。

### 8. 界面

**输入框的 Skill 选择器**（「＋ Skill」与 `/`）底部固定一行，有两个入口：「导入 Skill…」和「管理」。项目还没有 skill 时，选择器显示「项目里还没有 Skill」和「导入 Skill…」按钮。

**Skill 管理窗口**（标题「项目 Skill」）：

- 顶部：「导入 ▾」（从文件夹… / 从压缩包… / 从其他项目…）、「在访达中显示」（`fs.reveal { spaceId, skills: true }`）。
- 列表：名称、描述（两行截断），每行有「移除」。移除前要确认，文案是「移到应用的已移除目录，之后可以找回」。
- 有 `problems` 时，下面折叠一段「无法识别的目录（N）」，列出目录名和原因。
- 窗口可以接收拖进来的 `.zip` / `.skill` 文件。

**确认导入窗口**（暂存成功后弹出）：

- 来源路径，以及每个候选的勾选框、名称、描述、文件数与大小。
- 含脚本时显示「含脚本」标记，悬停列出文件。
- 同名的候选默认不勾选，标「已存在」；勾选它即表示替换，按钮文案变成「导入并替换」。
- `skipped` 折叠显示在最下面。没有任何候选时只显示原因和「关闭」。
- 「导入 N 个」提交；「取消」或关闭窗口调用 `skill.discard`。
- 导入完成后弹出提示「已导入 N 个 Skill」，刷新选择器。新导入的 skill **不会**自动选进当前消息。

**从其他项目…**：用 `space.list` 选项目（不含当前项目），再用 `skill.list { spaceId }` 列出它的 skill 让用户勾选，然后 `skill.stage { fromSpaceId, names }` 进入同一个确认窗口。

所有 aria-label 与文案用中文；动画遵守 `prefers-reduced-motion`。

### 9. 契约

`packages/protocol/src/runtime.ts` 新增 `skill.*`，五个方法只允许 `ui` 调用；Agent 不能通过协议写入 skill 目录。

| 方法 | 参数 → 结果 | 说明 |
|---|---|---|
| `skill.list` | `{ spaceId? }` → `{ skillsPath, skills, problems }` | 见 7 |
| `skill.stage` | `{ spaceId?, path }` 或 `{ spaceId?, fromSpaceId, names }` → `{ stagingId, source, candidates, skipped }` | 见 3、4。来源不存在 → `not_found`；超限、符号链接、坏压缩包 → `invalid_params`，消息说明原因与路径 |
| `skill.import` | `{ spaceId?, stagingId, names, replace? }` → `{ imported, replaced }` | 见 5。暂存区不存在或过期 → `not_found` |
| `skill.discard` | `{ stagingId }` → `{ ok }` | 重复调用也成功 |
| `skill.remove` | `{ spaceId?, name }` → `{ ok, removedPath }` | 见 6。名称不存在 → `not_found` |
| `fs.reveal` | 增加 `skills: true`（只能配合 `spaceId`） | 打开项目 `skills/` |

网页宿主的 `/upload` 增加 `kind=skill`：同样校验令牌与 Origin，把文件写进临时目录后调用 `skill.stage { spaceId, path }`，把它的结果原样返回，之后删掉临时文件。上限沿用 `maxUpload`；256 MiB archive / 512 MiB unpacked limits are enforced by `skill.stage`.

（2026-11-05 修订：全局 skill 库改由 [RFC 0033](0033-author-skill-library.md) 提供。）

已确认（维护者 2026-10-30）：不做全局 skill 库，跨项目靠「从其他项目」复制；暂不支持网址或 Git 导入；同名默认不覆盖，勾选替换后旧目录保留；移除是移到 `removed-skills/`，不自动清理。

## 不做

- 全局 skill 库、跨项目同步或版本更新提醒。
- 从网址、Git 仓库、Agent 自己的 skill 目录导入。
- 在应用里编辑 skill 内容（可以「在访达中显示」后自己改）。
- 冻结 skill 正文版本（0008 不变）。
- 让 Agent 自己导入或创建 skill。Agent 在自动模式下本来就能写项目目录，这一点不变。

## 验收

- `pnpm check` 通过；`pnpm build` 后完整 e2e 连续两轮通过。
- 单元测试（studiod）：
  - 文件夹与 zip 的候选识别：根目录、外包一层、多个 skill、嵌套不重复计入。
  - frontmatter 缺字段与非法目录名进入 `skipped`。
  - 拒绝情况：符号链接、`..`、绝对路径条目、重名条目、加密条目、超过文件数或字节数、声明大小与实际解压大小不符。
  - 执行位与脚本识别。
  - 同名不替换时整次不写入；替换时旧目录进入 `removed-skills`。
  - `.importing-*` 不出现在列表中。
  - 暂存过期与启动清理。
  - 移除后可在返回路径找到原内容。
  - `skill.list` 的 `problems`。
  - 从其他项目复制。
  - 五个方法拒绝 Agent 调用。
- 网页宿主测试：`/upload?kind=skill` 的令牌、Origin 校验与临时文件清理。
- e2e：
  - 从文件夹导入（`VIS_PICK_DIRECTORY`）后，选择器里出现新 skill，并能选进消息发送；Agent 收到的提示里有它的路径。
  - 上传包含两个 skill 的 zip，只勾选一个导入。
  - 同名导入时勾选替换。
  - 移除 skill 后列表里不再出现。
  - 无法识别的目录出现在管理窗口里。
- 两份 README（中英）与路线图更新；0008 的「技能发现与显式选择」一节链接到本 RFC。

## Windows validation follow-up (2026-11-05)

Implementation fixed; Windows revalidation pending. `SKILL_SOURCE_LIMITS` in protocol is the shared source for folder staging and `readSkillZip`: 256 MiB archived, 512 MiB unpacked, 10,000 regular files. The archive parser now receives these values explicitly; manuscript ZIP limits are unchanged. Real ZIP payloads cover one byte below, at and above both byte limits, and 9,999 / 10,000 / 10,001 files. Localized ZIP errors already used the raised limits. The Windows issue stays open until real staging is rerun there.
