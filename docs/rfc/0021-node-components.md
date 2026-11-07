# 0021 · 节点组件（第四期 a）：工具条、本地媒体操作、操作目录、输入面板

状态：已实现（2026-11-01）

日期：2026-10-31

设计参考图在仓库外的 `F:/workspace/设计参考图/`（图组件、视频组件、语音组件）。脚本节点拆到 4b（RFC 0023），本文不涉及。

## 背景

前三期把画布、会话、工作项和生成链路打通了，但节点本身还很薄：选中图片、视频、音频节点后只有底部的提示词面板和版本条，没有任何针对素材本身的操作。想裁一张图、截一段视频、切一段配音，只能下载到外部工具处理完再上传，或者让 Agent 重新生成（花钱，还不一定一致）。

参考图里的产品把操作都放在节点顶部的工具条上，但它们大部分操作背后是某个模型（高清、扩图、抠图、去字幕）。我们不能把组件和某家服务商绑在一起：

- 用户可能一个服务商都没配，组件也要能用；
- 服务商能做什么各不相同，而且会变；
- 测试和开发不调用真实服务（AGENTS.md 成本规则）。

## 目标

1. 图片、视频、音频节点统一成「**顶部工具条 + 节点本体 + 底部输入面板**」。
2. **组件只认操作目录，不认服务商**。没有配置任何生成服务时，本地操作（裁剪、切分、截取、变速、抽帧、分离音频）照样完整可用；生成类操作由服务商的模型声明支持，组件按目录显示入口。接入或去掉一家服务商都不用改组件。
3. 本地操作 Agent 和用户都能调用，权限、幂等、撤销规则和现有的画布写入一致。
4. 输入面板支持带编号的参考素材，可以在提示词里引用；参数行完全由 `paramsSchema` 生成。

## 不做

- 蒙版编辑，以及依赖它的擦除、重绘（下一期）。
- 自定义工具栏：本期只在「更多」菜单里放一个入口，显示「即将支持」，不能点。
- 脚本节点、分镜表、资产管理（4b / RFC 0023）。
- 接入新的服务商或真实模型。生成类操作本期只由 mock provider 声明，用来测试目录和入口；方舟不声明任何操作。
- 720° 全景、逐帧拉片、人像质感、角色库、特效、运镜。

## 决定

### 1. 三层解耦

| 层 | 位置 | 职责 |
|---|---|---|
| 组件 | `canvas/ui` | 工具条、标题行、播放器、波形、输入面板。只读操作目录，只调 `protocol` 方法 |
| 操作目录 | `protocol` | 本地操作是静态常量；生成类操作由 `providers.list` 里各模型的 `operations` 声明 |
| 执行 | `assets`、`generation`、`studiod` | 本地操作在 studiod 里用 ffmpeg 执行（仓库已依赖，不加新依赖）；生成类操作走 `generation.submit` |

组件计算某个节点可用的操作 = 适用于该节点类型的本地操作 ∪ 已配置服务商声明的、适用于该类型的生成类操作。不新增「查询可用操作」的方法，`providers.list` 已经够用，Agent 也能读到。

### 2. 操作目录（`protocol/src/operations.ts`，新文件）

```ts
// 本地操作：studiod 用 ffmpeg 执行，不计费、不占生成并发
export const LocalOperation = z.enum([
  'image.crop', 'image.gridSplit',
  'video.trim', 'video.frame', 'video.extractAudio',
  'audio.trim', 'audio.split', 'audio.speed',
])
// 生成类操作：只有模型在 providers.list 里声明了才可用
export const GenerationOperation = z.enum([
  'generate',                                   // 现有的「按提示词生成」，缺省值
  'image.upscale', 'image.outpaint', 'image.matting', 'image.multiview',
  'video.upscale', 'video.removeSubtitles', 'video.reshoot',
])
```

每个本地操作的参数和产出：

| 操作 | 参数 | 产出 |
|---|---|---|
| `image.crop` | `{ x, y, w, h }`，素材像素坐标 | 替换当前节点素材（新版本） |
| `image.gridSplit` | `{ rows, cols }`，各 2–3 | 新建 rows×cols 个图片节点，排在原节点右侧，输入连到原节点 |
| `video.trim` | `{ startMs, endMs }` | 替换当前节点素材 |
| `video.frame` | `{ atMs }` | 新建图片节点（复用 `media.ts` 的抽帧） |
| `video.extractAudio` | `{}` | 新建音频节点；没有音轨时返回 `invalid_params` |
| `audio.trim` | `{ startMs, endMs }` | 替换当前节点素材 |
| `audio.split` | `{ pointsMs: number[] }`，1–20 个，严格递增，在时长内 | 新建 n+1 个音频节点，原节点不变 |
| `audio.speed` | `{ rate }`，0.5–2，步长 0.25 | 替换当前节点素材（`atempo`，不变调） |

参数 schema 和产出类型都放在 `operations.ts`，界面和 Agent 共用。

### 3. 新方法 `media.process`、`media.get` 与 `media.analyze`

```ts
'media.process': {
  callers: both,
  params: {
    requestId, operation: LocalOperation, nodeId, slotId,
    expectedRevision,                   // 先读后写，和 slot.setAsset 一致
    params: Record<string, unknown>,    // 按 operation 校验
    waitMs?: number,                    // 0–30000，和 generation.get 相同
  },
  result: MediaTaskView,
}
'media.get': {
  callers: both,
  params: { taskId, waitMs? },
  result: MediaTaskView,
}
// status: queued | running | succeeded | failed；succeeded 时带 assetVersionIds、nodeIds，failed 时带 error
MediaTaskView = { taskId, status, operation, nodeId, assetVersionIds?, nodeIds?, error? }

'media.analyze': {
  callers: both,
  params: { operation: z.literal('audio.silence'), nodeId, slotId, params: { minSilenceMs?, thresholdDb? } },
  result: { durationMs, pointsMs: number[] },   // 每段静音的中点，作为候选切点；只读、很快，保持同步
}
```

- **参数形状**：MCP 要求工具参数顶层是 object，所以 `media.process` 的参数是扁平对象（`operation` 枚举 + `params` 记录），由服务端按 operation 校验 `params`；各操作的参数写在方法说明里，Agent 通过 `capabilities.describe` 读到。
- **异步执行**：`vis` 命令行的 RPC 超时是 35 秒（`apps/cli/src/client.ts`），长视频的截取和重新编码会超过这个时间，所以 `media.process` 不同步等结果。
  - 提交后返回任务；`waitMs` 内完成的，直接返回 `succeeded`，图片操作通常这一步就结束了。
  - 没完成的，调用方用 `media.get` 继续查。CLI 加一条 `vis media wait <taskId>`，和 `vis gen wait` 一样。
  - 单个任务上限 **30 分钟**，超时就停止 ffmpeg，返回 `failed`（`media.timeout`）。
- **持久化**：新表 `media_tasks`（每个项目的 `space.db`），列为 requestId、状态、参数、结果、错误、创建时间。完成时登记素材、写节点、把任务标为成功，这三步在同一个事务里，不会留下孤立素材。
- **幂等**：同一个 `requestId` 返回同一个任务，不重复处理。
- **重启**：studiod 启动时，把 `running` 的任务标为 `failed`（`media.interrupted`）。本地处理不花钱，重新发起就行，不自动续跑。
- **并发**：全机最多同时跑 2 个本地任务，多出来的排队。本地任务不占生成并发，也不占 0009 的执行名额。
- **事件**：新增 `mediaTask.stateChanged`，payload 为 `MediaTaskView`；`SpaceSnapshot` 新增 `activeMediaTasks`（未结束的任务），重连后界面据此恢复处理中状态。界面据此在节点上显示处理中（进度条用 ffmpeg 的 `-progress` 输出），期间禁用这个节点的工具条。失败时节点上出现可以关闭的提示，和生成失败一样。
- **取消**：不新增独立 `media.cancel`。回收工作项或停止会话轮次时，中止该会话排队与运行中的媒体任务，以 `media.cancelled` 失败；正常结束的轮次也不得继续写回。
- **写回**：任务完成时，替换类操作在同一事务里登记素材、执行 `slot.setAsset`（`expectedRevision` 在完成时再检查一次：处理期间节点被改过，任务就以 `revision_conflict` 失败，不覆盖新内容），并沿用 0020 的「按素材比例调整高度」。新建类操作走和 `node.create` 一样的不重叠摆放（0016），新节点的 `inputs` 指向原节点，这样连线能看出来源。
- **撤销**：用户发起的操作是一个撤销步骤（替换恢复原版本，新建删除新节点）；Agent 发起的不记撤销，和 `canvas.apply` 一致。
- **权限**：与 `canvas.apply` 写节点的检查相同（Agent 要有关联且未归档的会话）。
- **素材来源**：只读节点当前槽位里已登记的素材，不接受路径参数，Agent 无法借此读任意文件。
- 事件沿用 `node.created`、`node.updated`、`slot.updated`，界面不用新增事件处理。
- MCP 工具名 `vis_media_process`、`vis_media_analyze`；`prompt.ts` 补一段：裁剪、截取、切分这类处理优先用本地操作，不要为此提交生成任务。

### 4. 生成类操作

- `providers.list` 中每个模型新增 `operations: GenerationOperation[]`，缺省为 `['generate']`（旧配置和方舟模型不用改）。
- `generation.submit` 新增可选字段 `operation`，缺省为 `'generate'`。模型没有声明该操作时返回 `invalid_params`，**在占用额度之前**拒绝。
- `ProviderRequest` 新增 `operation` 字段，`validateInputs` 同时接收 operation。
- 除 `generate` 外，其他操作都以当前节点的 `main` 槽位作为第一个输入，提示词可以为空（`prompt` 对非 `generate` 操作改为可选）。
- 产出**新建节点**，放在原节点旁边，输入连到原节点，不覆盖原素材，方便对比（维护者 2026-10-31 确认）。服务端把这些操作的 targets 缺省为 `new_node`，`nearNodeId` 为原节点。`generate` 保持现有行为。
- mock provider 的 mock 模型声明全部生成类操作，返回带操作名水印的占位素材，用来测试入口、提交和交付。

### 5. 顶部工具条（`canvas/ui`）

- 只在选中**单个**图片、视频、音频节点时出现，位于节点上方；版本条（`VersionStrip`）移到节点下沿和输入面板之间，不再占顶部。
- 布局：常用操作（图标 + 文字）｜「更多」菜单｜下载｜全屏（音频没有全屏）。
- 每类节点外露哪些操作写成常量，放在 `canvas/ui/src/toolbar.ts`；其余操作进「更多」。目录里没有的操作不显示，不显示禁用状态。
- 生成类操作带一个小标记（例如右上角的点），和本地操作区分开，提示这一步会调用服务商、可能计费。
- 点击后的交互：
  - 裁剪：节点进入裁剪态，出现可拖动的选框和比例预设（自由、1:1、4:3、16:9、9:16），回车确认、Esc 取消；
  - 宫格切分：下拉选 2×2、3×3，节点上预览切线，点击确认；
  - 截取（视频、音频）：时间轴上出现两个把手，确认后执行；
  - 抽帧：取当前播放位置；
  - 自定义切分（音频）：在波形上点击添加切点，可以拖动、删除；
  - 智能切分（音频）：先调 `media.analyze`，把候选切点画在波形上，用户增删后确认，最后一步和自定义切分相同；
  - 变速：0.5×–2× 分段选择；
  - 生成类操作：直接提交，使用节点当前选择的服务商和模型（若该模型不支持此操作，则用第一个支持的模型）。
- 工具条键盘可达：方向键在按钮间移动，所有按钮有 `aria-label`。动画遵守 `prefers-reduced-motion`。
- 「更多」菜单底部放「自定义工具栏」，禁用，悬停提示「即将支持」。

### 6. 标题行

- 节点新增可选字段 `title`（`NodeMeta`，1–60 字符，可为 null），需要迁移，用 `db:generate` 生成。
- 标题行在节点左上方外侧：类型图标 + 标题。没有标题时显示类型名和序号（「图片 3」）。图片和视频在右侧显示素材尺寸（`1280 × 720`），音频显示时长。
- 双击标题可重命名，走 `canvas.apply` 的 `node.setMeta`（`title` 为 null 表示清除），可以撤销。`node.create` 也可以直接带 `title`。
- 复制节点时标题加「副本」后缀（文案放在 `messages.ts`）。

### 7. 节点本体

- **视频**：控件收进底部一行（播放/暂停、当前时间、进度条、总时长、音量、全屏），没有悬停时淡出；AI 生成的素材左上角显示「AI 生成」标签，依据是槽位的 `source`。
- **音频**：波形上有播放头（红线）；点击或拖动定位；下方一行是当前时间、播放按钮、总时长。截取和切分态下复用这条波形。
- **图片**：不变；裁剪态和切分预览叠加在图片上面。

### 8. 输入面板

- **参考素材编号**：仅对持有素材的图片、视频、音频输入，按 `inputs` 顺序去重后从 1 编号；文本与空媒体输入不编号。缩略图左上角显示序号，音频显示时长。
- **提示词里引用**：输入 `@` 或点击缩略图，会在光标处插入引用标签，显示为「缩略图 + 图片 7」。存储格式是 `{{ref:<nodeId>}}`，编号在显示时按当前顺序计算，所以调整顺序或删除别的输入后编号依然正确。
  - 提交时服务端把引用标记替换成「图片 N」「视频 N」「音频 N」（N 按同一媒体素材编号规则计算，不计提示词槽位），再交给 provider。
  - 引用了已不在 `inputs` 里的节点：标签显示为失效样式，发送按钮禁用；服务端同样检查，返回 `invalid_params`。
  - Agent 写提示词时也可以用同样的标记，`prompt.ts` 补充说明。
- **来源按钮**：「上传」（选择本机文件，在原节点附近新建素材节点并加为输入）、「画布参考」（现有的点选）。
- **参数行**：模型选择器右边一行摘要，例如「16:9 · 720P · 5s · 1 个」，点击展开参数浮层。字段全部来自 `paramsSchema`（沿用 `params.ts`），组件里不写死任何参数名。
- 面板右上角的展开按钮：把面板放大成居中的对话框，方便写长提示词。

#### 实现时的补充（N4）

- 展开使用 ui-kit 的原生 `dialog.vis-dialog` 样式，编辑器始终挂载在同一位置，展开、收起不会重置光标或编辑历史；展开时按 Esc 仅收起，不丢弃文本。引用、普通输入、换行、纯文本粘贴共用本地撤销栈；输入法组合期间不重建标签、不保存中间文本，也不响应提交快捷键。
- 参数摘要按 `paramsSchema.properties` 顺序读取当前值和默认值；字符串直接显示，数字和布尔值带字段的本地化名称，不猜测模型未声明的单位。独立参数浮层与原有模型浮层共用同一套 schema 控件，原模型浮层保留参数编辑以兼容现有操作习惯。
- 缺失节点、文本与空媒体输入均不占编号，不提供 `@` 候选或缩略图插入；已有标记显示失效并禁用发送。失效标记保留原节点 ID，重新加入有效媒体素材后自动恢复。上传接口尚未接入时禁用上传按钮。

## 契约变更汇总

| 位置 | 变更 |
|---|---|
| `protocol/operations.ts` | 新增 `LocalOperation`、`GenerationOperation` 及各本地操作的参数 schema；`numberReferences` 统一媒体素材引用编号 |
| `protocol/methods.ts` | 新增 `media.process`、`media.get`、`media.analyze`（callers：both） |
| `protocol/events.ts` | 新增事件 `mediaTask.stateChanged`；`SpaceSnapshot.activeMediaTasks`；瞬时通知 `events.mediaProgress` |
| `apps/cli` | `vis media wait <taskId> [--timeout-ms N]` |
| `protocol/providers.ts` | 模型新增 `operations`，缺省为 `['generate']` |
| `protocol/generation.ts` | `generation.submit` 与 `JobView` 新增 `operation`；`prompt` 缺省为空串，`generate` 仍要求非空，其他操作要求至少一个输入 |
| `protocol/canvas.ts` | `NodeMeta`（`node.create`、`node.setMeta`）与 `NodeView` 新增 `title` |
| `storage` | `nodes.title` 列、`media_tasks` 表，迁移由 `db:generate` 生成 |
| `generation/providers/types.ts` | `ProviderRequest.operation`，`validateInputs` 增加 operation 参数 |
| `workbench/*/prompt.ts` | 本地操作优先；引用标记；标题 |

## 测试

- `protocol.test.ts`：各本地操作的参数边界；`operation` 缺省值；引用标记格式。
- `assets`：用 ffmpeg 生成的小样本覆盖每个本地操作（裁剪后的尺寸、截取后的时长、切分后的段数、变速后的时长、无音轨视频提取音频报错）。
- `studiod/gateway.test.ts`：权限（未关联会话的 Agent 被拒）；幂等（同一 requestId 只处理一次）；`expectedRevision` 冲突（包括处理期间节点被改）；用户操作可以撤销，Agent 操作不记撤销；超时和重启后任务标为 `failed`，且不留素材；并发上限 2，多出的排队。
- `generation.test.ts`：未声明的操作在占用额度前被拒；mock 模型的操作交付到新节点并连线；引用标记的替换和失效引用。
- e2e（按 `aria-label` 定位）：
  - 未配置任何服务商时，图片工具条只显示本地操作；
  - 裁剪 → 撤销 → 重做；
  - 宫格 2×2 生成 4 个连线节点；
  - 视频截取、抽帧、提取音频；
  - 音频智能切分：候选切点出现，删掉一个后确认，段数正确；
  - 在提示词里插入引用，删掉被引用的输入后发送按钮禁用；
  - mock 模型的「高清」入口出现并交付到新节点。

## 并行拆分

| Worker | 范围 | 依赖 |
|---|---|---|
| W1 契约与执行 | `protocol`、`storage`、`assets`、`generation`、`studiod`、`apps/cli`、`workbench/*/prompt.ts` | 契约由 Claude 先提交到集成分支 |
| W2 工具条与图片 | `canvas/ui` 中的工具条、标题行、图片裁剪和切分 | 契约 |
| W3 视频与音频 | `canvas/ui` 中的 `VideoPlayer`、`AudioPlayer`、波形、截取和切分交互 | 契约；工具条的挂载点（与 W2 约定 `toolbar.ts` 的接口） |
| W4 输入面板 | `canvas/ui` 中的 `PromptEditor`、`ModelPicker`、引用标签 | 契约 |

W2–W4 都在 `canvas/ui` 下，按文件划分：`CanvasView.tsx` 只由 W2 修改；W3、W4 的组件拆到独立文件，由 W2 统一挂进 `CanvasView.tsx`。

## 已确认（维护者 2026-10-31）

- 剧本拆解交给 Agent 会话，不新增文本生成服务商（4b）。
- Windows 支持（RFC 0022）先于本文实现，本文的单测与 e2e 在 Windows 上验证。
- 蒙版编辑放到下一期；自定义工具栏只留入口；音频智能切分用 ffmpeg 静音检测，Agent 通过同一组方法也能自己切。
- 生成类操作产出新节点。
- 本地处理时长放宽：改为异步任务，单个上限 30 分钟（原草案是同步、120 秒，超过 CLI 的 35 秒 RPC 超时）。
- 第四期拆成 4a（本文）和 4b（脚本节点，RFC 0023）。

## 实现时的补充（N1：后端）

- `waitMs` 只影响等待，不参与本地任务的幂等指纹；指纹包含发起会话，不能借其他会话的 requestId 复用写入。排队与运行中的任务在重启后都标记为 `media.interrupted`，不自动重放；关闭项目时先中断处理并释放临时文件。
- 本地处理固定提交时的素材版本；替换操作完成时同时检查槽位 revision 与节点 layoutRevision，因此处理期间清空槽位、重命名或调整节点也会报 `revision_conflict`。素材登记、画布批次、撤销记录和成功事件同事务；失败释放未登记的暂存 blob，保留其他并发暂存或已登记的同内容 blob。
- 图片输出 PNG，音频输出无损 PCM WAV，视频截取重新编码 H.264/AAC；宫格按行优先，边界取整后覆盖整张图，不丢弃奇数尺寸边缘像素。静音检测默认最短 500ms、阈值 −35dB，首尾静音也给出区间中点。
- 生成作业单独持久化 operation。非 generate 操作的第一个输入必须是主体的 main 媒体槽位；默认交付新节点并显式保存主体连线。mock 图片和视频占位素材带可见操作名；Ark、render 仅支持 generate，不声明附加操作。
- 原提示词（含引用标记）保存在作业参数 prompt，提交给服务商的编号文本另存 resolvedPrompt；编号由 `protocol.numberReferences` 统一计算，仅计持有素材的媒体节点，按输入顺序去重。错误引用在事务内拒绝，不占生成额度。异步任务 error.code 使用可翻译原因码，修订冲突保持 revision_conflict。
- R1：Agent 媒体写入复用活跃轮次检查，普通项目会话可调用；仅当会话关联工作项时检查其执行状态。任务保留发起轮次身份，在暂存前及写回事务内重新检查；轮次结束、实例退出或已请求停止时以 `media.cancelled` 失败，不登记素材。回收还会中止已结束轮次遗留的任务。
- R1：浏览器时长与 ffprobe 的差值最多容忍 50ms，仅将 `endMs`、`atMs` 裁到探测时长；超出仍报 `media.time_out_of_bounds`，裁后空区间仍拒绝。裁剪、宫格切分先按 EXIF／显示矩阵方向旋正，以浏览器显示尺寸检查边界，输出正向 PNG。
- R1：`mediaTask.stateChanged` 仅状态变化时持久化；进度只留在内存并经 `events.mediaProgress` 瞬时通道推送，每任务最多每秒 4 次，不更新任务表或持久事件，终态后丢弃迟到进度。处理超时由调用服务统一拥有，ffmpeg 适配器只遵守传入 signal；空闲检查只查询是否存在活跃媒体任务，不逐条读取任务视图。

## 实现时的补充（N2：工具条、标题、图片与宿主）

- N2：默认标题的序号按当前画布顺序、同类节点分别计算；复制没有显式标题的节点时，以当前默认标题加「副本」保存为显式标题，长标题截短主体，始终保留后缀并遵守 60 字符上限。
- R1：标题展示与复制共用 `canvas/ui` 导出的 `nodeTitleNumber`，按画布 z 顺序计算同类序号，显式命名节点同样占位。
- N2：常用入口为图片「裁剪、宫格切分、高清」、视频「截取、抽帧、高清」、音频「截取、自定义切分、智能切分」，其余目录操作进入「更多」。查看历史版本时禁用顶部工具条，避免把历史画面误当作当前素材处理。
- N2：工具条按屏幕像素避让自身标题及横向相交的其他节点，遇到重叠时上移到相邻节点之上；框不参与避让。标题保留原有悬停/选中显示行为，非编辑时仍可拖动节点。
- N2：版本条放在节点下方、输入面板之前，仅存在多版本时为输入面板预留间距。媒体面板在确认后等到任务成功才关闭；失败保留面板并在节点显示可关闭通知。切换选择或当前素材修订后退出面板，防止把旧预览的参数提交给新素材。
- N2：裁剪选框支持拖动、右下角缩放及方向键微调；比例预设及提交参数都使用原图像素，预览等比缩放；宫格切线只作预览，确认后才发起处理。上传多个参考素材后，在一个画布批次中新建节点并追加到最新读取的输入列表，形成一次撤销步骤。

## 实现时的补充（N3：视频与音频）

- 视频抽帧面板继承被替换播放器的当前播放位置；只在前端按素材 URL 暂存最近位置，不写入节点或协议。截取区间以整数毫秒保存，最短 1 毫秒；面板时间码显示毫秒精度，预览到终点自动暂停。
- 音频智能切分候选先排序、去重并排除首尾端点，超过 20 个时保留最早的 20 个。切点拖动不能越过相邻切点；键盘方向键每次移动 100 毫秒，Shift 加方向键移动 1 秒，Delete 删除；也可用波形播放头定位后点击按钮添加切点。
- 音频变速选项直接读取 `LOCAL_OPERATION_PARAMS`，不显示契约排除的 1×。素材来源标签随当前预览版本切换；本地面板的提交错误保留到下一次提交，取消不提交操作。

## UI polish (2026-11-05)

Floating node actions and media version strips now stay within the visible canvas and avoid fixed canvas controls while panning/resizing; the node layout is unchanged.
