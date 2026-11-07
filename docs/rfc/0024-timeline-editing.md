# 0024 · 剪辑节点：多片段剪辑、配乐与音效混音

状态：a–e（含 E2）已实现；低配实测、Windows LGPL 构建及部分真实 Agent 验收待补，见文末（2026-11-05）

日期：2026-11-01

接续 [0021](0021-node-components.md)（本地媒体操作）和 [0023](0023-script-nodes.md)（脚本节点）。0023 把「时间线剪辑、按镜头时长自动拼接成片」列为不做，由本文接手。排在 0023 之后实现。

## 背景

视频、音频节点已经能生成、上传、播放，0021 又加了截取、变速、切分这类单素材处理。但用户手里有了 5–6 个分镜视频、一段配乐、几个音效之后，还是没法在 visCreative 里把它们拼成一条片子：只能全部下载，到外部剪辑软件里做完再传回来。素材、版本、Agent 的上下文就此断开。

## 目标

1. **单素材的叫修改，多素材的叫剪辑**（维护者 2026-11-01 确认）：
   - 只动一段素材的（截取、变速、淡入淡出、音量、响度），仍是视频 / 音频节点工具条上的本地操作，产出新版本或新节点；
   - 涉及两段及以上素材的（拼接、给视频配乐、多段配音混音），由新的**剪辑节点**承担。
2. 剪辑节点保存一份可以反复修改的剪辑表。Agent 可以直接排一版粗剪，用户再打开修改；导出成片不重新生成素材，不花生成费用。
3. 导出产物是普通的视频 / 音频节点，下游的参考、首尾帧、继续生成都不需要认识剪辑节点。
4. 剪辑文档从第一版起按多轨设计，以后加字幕、转场、多视频轨叠加时只放开限制，旧节点不迁移。
5. 按桌面 app 的要求设计性能和打包：重活在 studiod 和 ffmpeg 里，渲染进程只负责画和播；指标写进本文，实现后实测。

## 不做（0024a–c）

- 多条视频轨叠加（画中画、贴图、Logo），以及位置、缩放、透明度。
- 字幕 / 文字轨、转场（包括交叉淡化）、片段变速。
- 关键帧、滤镜、调色、音频 ducking。
- 服务端渲染的低清预览、代理文件。
- 桌面 app 本身的打包流程；本文只约定剪辑功能对打包的要求（§8）。

分步实现见 §10。

## 决定

### 1. 节点与数据

- `NodeKind`、`CanvasNodeKind` 增加 `timeline`（迁移由 `db:generate` 生成）。
- 剪辑节点有一个 `main` 槽位，新的槽位内容类型 `{ type: 'timeline', doc: TimelineDoc }`。沿用 0023 的「文档型槽位」做法，槽位 `revision` 照常递增，进版本历史。
- 新文件 `protocol/src/timeline.ts`：

```ts
TimelineDoc = {
  version: 1,
  // 输出规格；省略时取第一个视频片段的宽高和帧率，没有视频片段时导出音频
  output?: { width, height, fps },          // 宽高 64–3840 / 64–2160，偶数；fps 1–60
  tracks: Track[],                          // 有序，视频轨在前，音频轨按显示顺序
}
Track = {
  id, kind: 'video' | 'audio',
  name?: string,                            // 例如「配乐」「音效」「配音」
  muted: boolean,
  volume: number,                           // 0–2，轨道总音量
  clips: Clip[],
}
Clip = {
  id,
  source: { nodeId: Id, assetVersionId: Id },  // 锁定版本，见下
  startMs,                                  // 在时间线上的起点
  inMs, outMs,                              // 素材内的入点和出点；图片片段 inMs = 0，outMs 即显示时长
  volume: number,                           // 0–2；视频片段指它自带的原声
  fadeInMs: number, fadeOutMs: number,      // 0–10000，二者之和不超过片段长度
}
```

规则（服务端校验，违反返回 `invalid_params` 和原因码）：

- **a–c 最多 1 条视频轨、4 条音频轨**；每轨最多 200 个片段，全片最长 30 分钟。上限写成常量，以后放开不改形状。
- 视频轨上的片段可以是视频或图片（图片显示 0.5–30 秒，适合放 0023 的镜头图或片头卡）；音频轨只接受音频，也接受视频（只取音轨）。
- **视频轨首尾相接**：片段按顺序排列，`startMs` 必须等于上一片段的结束时间，第一个为 0；不允许空隙和重叠。界面拖动时自动吸附，Agent 排列时由服务端校验。音频轨可以自由摆放，但同一轨内不能重叠。
- `inMs < outMs`，且不超过素材时长（服务端按登记的 `durationMs` 检查，允许 0021 已有的小误差）。
- `source.assetVersionId` 必须是**本项目已登记**的素材版本，类型与轨道相符。剪辑表只引用素材 ID，没有路径字段，Agent 无法借导出读取任意文件。

**锁定版本**：片段引用 `nodeId + assetVersionId`。源节点重新生成或被修改后，剪辑仍用原来的版本，导出结果不会悄悄改变；编辑器在片段上标「有新版本」，用户点一下才换成新版本（入出点超出新素材时长时截到时长内）。源节点被删除后，素材仍属于项目，剪辑照常播放和导出，片段标「源节点已删除」。

### 2. 编辑接口

- `canvas.apply` 新增操作 `timeline.set`：`{ op: 'timeline.set', slotId, doc: TimelineDoc }`，整份替换，必须带槽位的 `expectedRevision`。剪辑表在上限内不大，整份替换让 Agent 的写法最简单（读 → 改 → 写回）。
- 冲突：版本不一致返回 `revision_conflict`。编辑器在本地保存草稿，松开鼠标或停止输入 500 ms 后提交一次；遇到冲突时显示「剪辑已被 会话名 修改」，提供「载入新版本」（放弃本地修改）和「查看差异」（列出增删改的片段），不提供强制覆盖。用户和 Agent 同时改同一个剪辑很少见，按片段合并的 patch 留到以后需要时再做。
- 用户的每次提交是一个撤销步骤；Agent 的写入不记撤销（与 `canvas.apply` 一致）。编辑器内另有一套本地撤销，范围是还没提交的草稿。
- 事件沿用 `slot.revised`，payload 带完整文档。
- `canvas.get` 返回完整文档；Agent 用现有的 `canvas_apply` 工具写。

### 3. 创建入口

- **画布新建**：新建菜单增加「剪辑」，创建一个空剪辑节点（1 条视频轨 + 1 条音频轨「配乐」）。
- **从节点创建**：选中一个或多个视频 / 音频 / 图片节点，工具条或右键菜单出现「创建剪辑」。视频和图片按画布上从左到右、从上到下的顺序排进视频轨，音频放进第一条音频轨。只选一个视频节点时也可以用，例如「给这段视频配乐」。
- **从脚本节点创建**（0024c，需要 0023 已经合并）：脚本节点工具条增加「组装成剪辑」，按镜头顺序取每个镜头当前的视频（没有视频的镜头用首帧图片，时长取 `durationSec`），生成剪辑节点。
- 新剪辑节点放在来源节点右侧（0016 的不重叠摆放），`inputs` 连到所有来源节点。之后增删片段时，服务端在同一事务里同步 `inputs`，让连线始终反映剪辑实际用到的节点。

### 4. 画布上的剪辑卡片

- 卡片上半部分显示最近一次导出的成片，可以直接播放；还没导出时显示第一个视频片段的画面。下半部分是一条迷你时间线：各轨的片段色块和总时长。标题旁有剪辑图标。外形与视频节点明显不同。
- 成片落后于剪辑表（剪辑在导出后又改过）时，卡片角上标「未导出的修改」。
- 选中剪辑节点时，0021 的顶部工具条显示：打开剪辑（0024b 起）、导出、下载成片。版本条显示剪辑表的历史版本，可以查看和恢复。
- 双击卡片或点「打开剪辑」进入编辑器（0024b 起）。

### 5. 编辑器

全屏编辑层（和 0023 展开分镜表同一类外壳），Esc 关闭。布局：上方预览，下方时间线，右侧是选中片段的属性。界面与交互细节见 [0024-ui-spec.md](0024-ui-spec.md)。

- **时间线**：轨道头（名称、静音、音量）+ 片段条。视频片段显示缩略图条，音频片段显示波形。播放头、时间刻度，可以缩放和横向滚动。
- **片段操作**：拖动换位（视频轨自动首尾相接，音频轨吸附到播放头和其他片段边缘）；拖动两端修改入出点；在播放头处切分；删除（视频轨删除后，后面的片段前移）；复制。属性面板中调音量、淡入淡出时长，以及「换成新版本」。
- **添加素材**：从画布把节点拖到某条轨道上；或在编辑器左侧的素材栏里选择，素材栏列出项目里的视频、音频、图片节点，可按类别筛选。
- **轨道**：增删音频轨（上限 4 条）、改名、静音、调轨道音量。
- **快捷键**：空格播放 / 暂停，S 在播放头处切分，Delete 删除，←/→ 逐帧移动，Cmd/Ctrl+Z 撤销。
- 所有动画遵守 `prefers-reduced-motion`；文案放进 `messages.ts`，时长用 `useFormat()` 格式化。

### 6. 预览：浏览器内近似播放，以导出结果为准

- **视频轨**：两个 `<video>` 元素交替使用。当前片段播放时，另一个预先加载下一个片段并定位到它的入点，到切点时直接切换。图片片段用 `<img>`。输出比例和素材比例不同时，用 CSS 加黑边，和导出时的补边方式一致。
- **音频**：每个正在发声的片段用一个 `<audio>` 元素，接入 `MediaElementAudioSourceNode` → 片段增益（淡入淡出用增益曲线）→ 轨道增益 → 输出。采用流式播放，不把整段音乐解码进内存。
- **时钟**：以 `AudioContext.currentTime` 为主时钟。媒体元素偏差超过 80 ms 时重新对齐，不逐帧纠偏。
- 同时存在的媒体元素：视频 2 个，音频最多为同一时刻发声的片段数（≤ 4 轨 + 视频原声）。内存不随片段总数增长。
- 预览允许在切点处有一两帧的误差，淡入淡出的曲线也可能和导出略有出入，以导出结果为准。界面不承诺逐帧精确。

### 7. 导出

- `LocalOperation` 增加 `timeline.export`，参数 `{}`，`LOCAL_OPERATION_OUTPUT` 为 `new_nodes`。调用方式与其他本地操作相同：`media.process`，`nodeId` / `slotId` 指向剪辑节点的 `main` 槽位，`expectedRevision` 为当时剪辑表的修订号。任务记录、幂等、30 分钟上限、全机并发 2、重启标记 `media.interrupted`、随会话停止取消，都沿用 0021。
- 剪辑表在导出期间又改过时，**不算冲突**：导出的是提交时那一版，成片标明对应的修订号（见下）。这和替换类操作不同，因为导出不覆盖任何内容。
- **产出**：有视频片段时，导出 MP4（H.264 + AAC，按 `output` 的宽高和帧率）；只有音频轨时，导出 AAC 音频（`.m4a`，需要时在 `MIME_BY_EXT` 补上）。产出新节点，放在剪辑节点右侧，`inputs` 连到剪辑节点，标题默认为「剪辑名 · 导出 vN」。
- 新节点带元数据 `exportOf: { timelineNodeId, timelineRevision } | null`（`NodeMeta` 加列）。剪辑卡片据此找到最近的成片，并判断它是否落后。与 0023 的 `shot` 一样，剪辑节点被删除后，成片保留，引用变成失效。
- **合成方式**（`packages/assets/src/timeline-render.ts`，纯函数，把剪辑表编译成 ffmpeg 参数）：
  - 视频轨：每个片段 `trim` / `atrim` 到入出点，`scale` + `pad` 到输出尺寸（保持比例、补黑边），`fps` 统一帧率，`setsar=1`；图片用 `loop` 生成定长画面；再 `concat`。没有音轨的视频片段补同样长度的静音。
  - 音频：各片段 `atrim`，`aresample=48000`，转双声道，用 `volume` 和 `afade` 处理音量和淡入淡出，`adelay` 定位到 `startMs`；各轨混合后乘轨道音量，最后 `amix`（`normalize=0`，不自动压低音量），再用 `alimiter` 防削波。
  - **能不重编码就不重编码**：只有一条视频轨、没有音频轨、所有片段都整段使用（入点为 0、出点为素材时长）、没有调过音量和淡入淡出、编码参数一致（编码器、宽高、帧率、像素格式、音频参数）时，用 concat demuxer 加 `-c copy`，几乎瞬间完成。分镜视频整段拼接正是这种情况。其他情况重编码。
  - 进度用 ffmpeg 的 `-progress` 输出，与 0021 一致。
- **编码器选择**：studiod 启动后第一次需要编码时探测一次，结果缓存：
  1. 硬件编码器，按平台顺序尝试：Windows 依次为 `h264_nvenc`、`h264_qsv`、`h264_amf`、`h264_mf`；macOS 为 `h264_videotoolbox`；Linux 为 `h264_vaapi`。每个都先实际编码 1 帧，确认可用。
  2. 软件编码器：`libx264`（开发机上常见的完整构建里有），否则用 `libopenh264`。
  3. 都不可用时，导出返回 `unavailable`（`media.encoder_missing`），提示安装或更新 ffmpeg。
  选择逻辑用假的编码器列表做单元测试，不依赖本机 ffmpeg 的构建方式。
- **权限**：与 `media.process` 一致。剪辑表里引用的素材已经在写入时校验过属于本项目，导出时再按 ID 读一次素材文件，不接受路径。

### 8. 性能与打包

剪辑功能按「将来跑在 `apps/desktop` 的 Electron 里」设计。

**架构约束**

- 解码、混音、编码都在 studiod 拉起的 ffmpeg 子进程里完成；Electron 渲染进程不解码整段媒体，不做像素处理。
- **波形和缩略图由服务端生成并缓存**（0024b）。现在 `canvas-ui` 的 `AudioWaveform` 会把整段音频下载下来用 `decodeAudioData` 解码，几分钟的配乐会占几十 MB 内存，也会卡住主线程。新增只读方法：

```ts
'media.preview': {
  callers: ui,
  params: { assetVersionId: Id, kind: 'peaks' | 'filmstrip' },
  result:
    | { kind: 'peaks', durationMs, binsPerSecond: 50, peaks: number[] }   // 0–1，最多 90000 个
    | { kind: 'filmstrip', durationMs, frameWidth, frameHeight, intervalMs, url },  // 一张横向拼接的 JPEG
}
```

  - 素材版本不可变，所以按 `assetVersionId` 缓存到项目的缓存目录，文件不登记为素材。删除项目时一起清理。`filmstrip` 的 `url` 沿用素材的受控访问方式。
  - 第一次请求时生成（音频峰值：ffmpeg 解码成 8 kHz 单声道 s16，在 Node 里算峰值），之后直接读缓存。生成也占用本地媒体任务的并发名额，但不建任务记录。
  - 音频节点的 `AudioWaveform` 也改用 `peaks`，不再在浏览器里解码（0024c）。
- 素材通过 HTTP Range 读取（web host 已经支持），预览拖动播放头时不需要下载整个文件。
- 编辑器的时间线虚拟渲染，只画可见区域的片段；拖动时只更新本地状态，松开后才提交。

**指标**（目标；macOS 实测见文末「实现时的补充（0024c 第二部分）」，参考机和最低配置的实测仍待补）

| 指标 | 目标 |
|---|---|
| 打开编辑器（50 个片段，缓存已生成） | < 500 ms |
| 拖动、缩放时间线（200 个片段） | 60 fps，单帧 < 16 ms |
| 点击播放到出画面 | < 300 ms |
| 预览片段切换 | 不出现黑帧 |
| 3 分钟音乐的波形，第一次 / 有缓存 | < 2 s / < 100 ms |
| 导出 1 分钟 1080p30，需要重编码 | 硬件编码不慢于实时 |
| 导出纯拼接（`-c copy`），10 个片段 | < 5 s |
| 编辑器打开时渲染进程内存 | < 500 MB |
| studiod 空闲 CPU | ≈ 0 |

测量机器：

- **参考机**：维护者的 Windows 11 开发机（20 逻辑核，16 GB）。
- **最低配置**（维护者 2026-11-01 按推荐确认，待实测）：8 GB 内存、4 核、没有独立显卡。最低配置上要求编辑器流畅、1080p 预览可用，导出允许慢于实时。如果最低配置上 1080p 预览达不到要求，再考虑代理文件（§10 的 0024e）。

**怎么守住**

- 新增性能测量脚本：用固定的 30 段和 200 段剪辑样例，测上表中能自动测的项目，结果写到 `/tmp` 下的报告里。**一开始只测量，不当作失败条件**。Windows 开发机有负载时测试本来就容易超时，不在 e2e 里加新的计时断言。数据稳定后再定阈值，并入路线图里已有的性能优化项。
- 单元测试只验证正确性：剪辑表编译出的 ffmpeg 参数、`-c copy` 的判断条件、编码器选择。

**打包 ffmpeg**（维护者 2026-11-01 按推荐确认）

- 桌面 app 打包 **LGPL 构建**的 ffmpeg / ffprobe（动态链接，不带 `--enable-gpl` / `--enable-nonfree`），放在 app 资源目录，通过已有的 `ffmpegPath` / `ffprobePath` 传给 studiod。用户不需要自己安装。
- LGPL 构建里没有 libx264，所以 H.264 编码依赖 §7 的硬件编码器，软件编码回退到 `libopenh264`（BSD 许可）。项目是 MIT 许可，动态链接 LGPL 的 ffmpeg 可以兼容。打包时附上 ffmpeg 的许可证文本和对应的源码获取方式。
- 开发环境照常使用本机安装的 ffmpeg（例如 Windows 上的 winget 完整构建）。代码不假设 libx264 一定存在。

### 9. Agent

- 各 Agent 的 `prompt.ts` 补充剪辑说明：
  - 什么时候用：用户要求拼接、配乐、混音、出成片时，建剪辑节点或修改已有剪辑节点；不要为此提交生成任务。
  - `TimelineDoc` 的写法：上限、视频轨首尾相接、锁定版本、`expectedRevision`，以及「先读 → 修改 → 整份写回」。
  - 导出：`vis_media_process` 加 `timeline.export`，导出后用 `vis media wait` 等结果。
  - 摆放：建议把来源镜头、剪辑节点、成片放进同一个 Frame（0016）。
- 只处理单段素材时，仍然用 0021 的本地操作，不建剪辑节点。
- 假 Codex 增加一个「排粗剪」场景，供 e2e 使用。

### 10. 分步实现

剪辑器拆成几步，**每一步单独验收、合并**，各自跑 `pnpm check`、`pnpm build` 和两轮 e2e（维护者 2026-11-01 确认）。剪辑文档从 a 起就是多轨结构，后面的步骤只放开上限、增加字段，旧文档继续有效。

| 步 | 内容 | 用户能得到什么 |
|---|---|---|
| **0024a 剪辑节点与导出** | §1、§2；§3 中「画布新建」和「从节点创建」；§4 剪辑卡片（此时没有「打开剪辑」）；§7 导出和编码器选择；§9 Agent | 框选几个镜头或音频，点「创建剪辑」，再导出成片；让 Agent 排粗剪、配乐、导出。修改剪辑暂时靠 Agent |
| **0024b 编辑器** | §5 编辑器、§6 预览播放器；§8 的 `media.preview`（编辑器需要缩略图条和波形）；卡片和工具条加上「打开剪辑」 | 用户自己打开剪辑，拖动、裁剪、切分、调音量和淡入淡出 |
| **0024c 性能与收尾** | §8 的其余部分：`AudioWaveform` 移入 `ui-kit`，音频节点改读 `peaks`；性能测量脚本，在参考机和最低配置上实测并调优，数字写回 §8；用 LGPL 构建（没有 libx264）验证导出；§3 中「从脚本节点创建」（需要 0023 已经合并） | 长音频不卡，各项指标有实测数据；分镜表一键组装成剪辑 |

「组装成剪辑」放在 c，是因为它要读 0023 的镜头顺序和结果节点的 `shot` 元数据。0023 合并前这些字段还可能变，放在最后可以让 a、b 不依赖 0023。在此之前，用户可以框选分镜视频再「创建剪辑」：0023 把每个镜头的结果排成一列，按画布位置排序基本就是镜头顺序。

以后的步骤沿用 0024 往下编号，每步开工前在本文补充决定：

| 步 | 内容 |
|---|---|
| 0024d | 字幕 / 文字轨、交叉淡化等简单转场、片段变速；单素材的 `audio.fade`、`audio.gain`、`audio.normalize` 也可以放在这一步 |
| 0024e | 多视频轨叠加：画中画、贴图或 Logo 轨，位置、缩放、透明度。从这一步开始，浏览器预览和导出的差异会变大，届时评估服务端低清预览和代理文件 |
| 以后再看 | 关键帧动画、滤镜和调色、音频 ducking、按片段合并的 patch 接口 |

## 契约变更汇总

| 位置 | 变更 | 步 |
|---|---|---|
| `protocol/common.ts` | `NodeKind`、`CanvasNodeKind` 增加 `timeline` | a |
| `protocol/timeline.ts`（新） | `TimelineDoc`、`Track`、`Clip`、上限常量、校验函数 | a |
| `protocol/canvas.ts` | `SlotContent` 增加 `timeline`；`canvas.apply` 增加 `timeline.set`；`NodeMeta` / `NodeView` 增加 `exportOf` | a |
| `protocol/operations.ts` | `LocalOperation` 增加 `timeline.export`（`new_nodes`） | a |
| `protocol/operations.ts` | 新方法 `media.preview` | b |
| `storage` | 槽位内容类型 `timeline`、`nodes.export_of_*` 列，由 `db:generate` 生成迁移 | a |
| `canvas/core` | `timeline.set` 校验（素材属于本项目、类型、时长、首尾相接、不重叠）、同步 `inputs`、撤销、版本历史 | a |
| `assets` | `timeline-render.ts`（剪辑表编译成 ffmpeg 参数、`-c copy` 判断）、编码器探测 | a |
| `assets` | 峰值和缩略图条生成 | b |
| `studiod` | `media-tasks.ts` 增加多来源的导出分支，写入 `exportOf` | a |
| `studiod` | `media.preview` 的缓存和并发 | b |
| `workbench/*/prompt.ts` | 剪辑说明（§9） | a |
| `ui-kit` | 新增原因码的中英文案 | a、b |
| `ui-kit` | `AudioWaveform` 移入 `ui-kit`，改为读取 `peaks` | c |

## 代码放置

| 内容 | 位置 |
|---|---|
| 剪辑编辑器（时间线、预览播放器、属性面板、素材栏） | 新包 `packages/timeline/ui`（`@vis/timeline-ui`），只依赖 `protocol` 和 `ui-kit`；在 `scripts/check-boundaries.mjs` 登记（b） |
| 剪辑卡片 | `canvas-ui`，注册进 `CanvasView.tsx`；「打开剪辑」由宿主注入回调，`canvas-ui` 不依赖 `timeline-ui` |
| 编辑器挂载 | `apps/web`（以后 `apps/desktop` 同样挂载），与 canvas-ui、workbench-ui 并列 |
| 波形组件 | b 中编辑器先通过 `ui-kit` 的新组件读取 `peaks`；c 中把 `canvas-ui` 的 `AudioWaveform` 合并过去，音频节点共用 |
| 片段编辑逻辑（切分、吸附、首尾相接重排） | `timeline-ui` 内部的纯函数，配单元测试；服务端以后也需要时再抽成独立包 |

## 测试

**0024a**

- 协议：`TimelineDoc` 边界：轨道数和片段数上限、视频轨有空隙或重叠、音频轨同轨重叠、入出点越界、淡入淡出超长、`output` 奇数宽高、图片片段时长范围。所有新方法的 MCP 参数 schema 顶层是 object。
- canvas core：引用其他项目或不存在的素材版本被拒；类型不符被拒；`inputs` 随片段增删同步；用户写入可撤销、Agent 写入不记撤销；版本冲突。
- `timeline-render`：针对代表性剪辑表的 ffmpeg 参数快照（只有视频、视频 + 配乐、只有音频、图片片段、输出比例与素材不同、视频片段没有音轨）；`-c copy` 的每个判断条件都有正反例。
- 编码器选择：假编码器列表加假试编码结果，覆盖各平台的优先顺序和最终回退。
- studiod：导出任务幂等；导出期间剪辑表被修改，仍按提交时的版本导出，并标出修订号；`exportOf` 写入；重启后标记中断；会话停止时取消；用 ffmpeg 合成 2 段视频 + 1 段音乐，产出的时长、分辨率、音轨符合预期（在测试里用 `lavfi` 生成测试素材）。
- e2e（假 Codex + mock）：选中 3 个视频节点「创建剪辑」→ 片段顺序正确、连线出现 → 导出，成片节点出现，卡片显示成片 → 假 Agent 改剪辑，卡片标「未导出的修改」→ 假 Agent 排一版粗剪并导出。

**0024b**

- `media.preview`：首次生成、命中缓存、不同 `assetVersionId` 互不影响、删除项目时清理。
- `timeline-ui` 纯函数：切分、吸附、视频轨删除后前移、入出点拖动的边界。
- e2e：打开编辑器，切分一个片段、拖进一段音频、调淡出 → 撤销 / 重做 → 提交后卡片更新 → 假 Agent 同时修改时出现冲突提示，「载入新版本」生效。

**0024c**

- 音频节点的波形改读 `peaks` 后，现有的音频 e2e 继续通过。
- 性能测量脚本能在参考机上跑完并产出报告（只测量，不断言）。
- 「组装成剪辑」：镜头顺序、缺视频的镜头用首帧图片和 `durationSec`。

所有 e2e 选择器用 `aria-label` 或可见文字。

## 并行拆分（草案）

每一步开工前，Claude 先提交这一步的契约和 UI 接缝。

**0024a**

| Worker | 范围 |
|---|---|
| A1 剪辑文档 | `storage`、`canvas/core` 的 `timeline.set` 与 `inputs` 同步、`exportOf`、`workbench/*/prompt.ts`、假 Codex 的粗剪场景 |
| A2 导出 | `assets/timeline-render.ts`、编码器探测、`studiod/media-tasks.ts` 的导出分支 |
| A3 画布与入口 | `canvas-ui` 的剪辑卡片、「新建剪辑」和「创建剪辑」入口、工具条项、e2e |

**0024b**

| Worker | 范围 |
|---|---|
| B1 预览数据 | `media.preview`：峰值和缩略图条生成、缓存、并发 |
| B2 时间线 | `packages/timeline/ui`：轨道、片段操作、属性面板、素材栏、快捷键、冲突提示 |
| B3 预览播放器与挂载 | `packages/timeline/ui` 的播放器（§6）、`ui-kit` 的波形组件、`apps/web` 挂载、e2e |

B2 和 B3 在同一个包里，按文件拆分。

**0024c** 体量小，一个 worker 完成；实测部分由 Claude 在参考机上跑。

## 已确认（维护者 2026-11-01）

- 单素材的叫修改，留在节点工具条上；多素材的叫剪辑，新增剪辑节点。
- Agent 可以直接排一版粗剪，用户可以打开剪辑节点修改。
- 剪辑文档从 a 起按多轨设计，后续支持简单的多轨剪辑。
- 要按桌面 app 的要求定性能指标；打包 LGPL 构建的 ffmpeg，配合硬件编码器；最低配置暂定 8 GB / 4 核 / 无独立显卡，待实测。
- 字幕和转场先不做；剪辑器拆成 a、b、c 等多步，每步单独验收、合并。
- 「组装成剪辑」放在 0024c，等 0023 合并之后再做。

## 实现时的补充（0024a 预先工作：W1 导出渲染）

0023 合并前先做了 `packages/assets` 里不依赖节点类型和存储的部分：`timeline-render.ts`（`planTimelineRender`、`probeTimelineSource`、`renderTimeline`）。契约 `protocol/timeline.ts` 已提交，但还没接进 `NodeKind` / `SlotContent`。

- 导出混音始终加入有限时长的 48 kHz 双声道静音底轨，保证空隙、静音轨和无原声视频都能导出；有画面时始终带 AAC 音轨。
- 音频轨比视频轨更长时，导出画面延长最后一帧到整个剪辑的结束；图片使用同一策略。静音轨仍计入文档总时长。
- 为保证导出结果符合「双声道 AAC」约定，复制模式只接受双声道 AAC 音轨；其他音频编码或单声道素材即使彼此一致也重新编码。带旋转元数据的画面同样重新编码。
- 编译计划的 `durationMs` 保留文档时长用于进度计算；执行结果的 `durationMs` 通过探测实际产物获得，避免复制模式中各片段允许的 50 ms 误差累积成错误的素材时长。
- 素材校验同时参考登记时长和探测时长，取较小值并沿用 0021 的 50 ms 容差；复制模式另要求出点与探测到的真实素材时长一致到该容差内。
- 当前 ffmpeg 9.0.2 支持 `-/filter_complex <file>`，帮助中已无旧的 `-filter_complex_script` 项，因此采用前者。后续打包版本应提供该文件参数语法。
- 输入按文件路径去重，并以共同父目录作为 ffmpeg 的 `cwd`、使用相对路径，避免 Windows 命令行长度随完整项目路径重复膨胀；不创建硬链接或复制素材。
- 命令行按 Windows 引号及反斜线展开后的估算长度设 30000 字符预算，给 32767 字符系统上限留余量；极端分散或过长的路径以 `invalid_params / timeline.too_many_sources` 拒绝，并提供中英文提示。
- 编码图使用 `alimiter=level=0:latency=1`，避免限制器自动增益或前视延迟改变剪辑混音的音量与对齐；`amix` 保持 `normalize=0`。
- 实测（参考机）：30 个片段的 1080p30 重编码导出 4.43 s（libx264）。本机 ffmpeg 不带 libopenh264，相应的导出测试被跳过，留到 0024c 用 LGPL 构建验证。

## 实现时的补充（0024a / b 预先工作：W2 编码器与预览数据）

`encoders.ts`（`detectVideoEncoder`）、`preview.ts`（`audioPeaks`、`filmstrip`、`createPreviewCache`）。`media.preview` 方法、studiod 的缓存目录和并发接入留到 0024b。

- 编码器列表与每次试编码的超时均为 5 秒；使用 256×256、30 fps 的 lavfi 黑色视频编码 1 帧，实际使用返回的全部编码参数，而不是只验证编码器名称。结果按传入的 ffmpeg 路径字符串在进程内缓存，同一路径的并发请求共享 Promise，失败结果也缓存；安装或更新后需要重启进程。
- Windows 严格按 NVENC、QSV、AMF、Media Foundation 顺序尝试；macOS 尝试 VideoToolbox；Linux 尝试 VAAPI；再依次回退到 libx264 和 libopenh264；各硬件优先级和失败跳过逻辑另外由假 runner 测试。
- NVENC 使用 `-preset p4 -rc vbr -cq 20 -b:v 0 -pix_fmt yuv420p`，兼顾速度与恒定质量。
- QSV 使用 `-preset veryfast -global_quality 20 -pix_fmt nv12`；AMF 使用 `-quality balanced -rc cqp -qp_i 20 -qp_p 20 -pix_fmt nv12`。
- Media Foundation 使用 `-hw_encoding 1 -b:v 8M -pix_fmt nv12`；VideoToolbox 使用 `-allow_sw 0 -b:v 8M -pix_fmt yuv420p`。这两个分支使用明确的 1080p 码率目标，避免依赖不同系统版本上支持不一致的质量参数，并禁止偷偷使用系统软件编码。
- VAAPI 默认设备为 `/dev/dri/renderD128`，通过 `inputArgs` 返回 `-vaapi_device`，通过 `filter` 返回 `format=nv12,hwupload`，使用 `-rc_mode CQP -qp 20`；设备不可用时继续软件回退，当前不扫描其他 render 设备。
- libx264 使用 RFC 示例的 `-preset veryfast -crf 20 -pix_fmt yuv420p`。libopenh264 没有 CRF，采用 `-b:v 8M -maxrate 12M -pix_fmt yuv420p`：8 Mbps 是 1080p 交付的固定目标，12 Mbps 允许复杂画面有一定余量；不要求 GPL 编码器存在。
- 预览先用 ffprobe 读取流信息和时长；显式传入 ffmpeg 路径时，从同一目录寻找 ffprobe/ffprobe.exe，默认则从 PATH 查找。ffprobe 有 30 秒超时；实际解码和拼图遵从调用者的 AbortSignal，不另设整体任务超时。
- 波形以 8 kHz 单声道 s16le 流式解码，处理跨 stdout chunk 的半个采样点；内存只保存有上限的峰值数组和一个待拼接字节。每 bin 的采样数向上取整，因此实际 `binsPerSecond` 可能略低于请求值；返回实际密度。时长按实际解码采样数计算，绝对振幅除以 32768 并保留三位小数。
- `maxBins` 默认且最多为 90000；根据探测时长提前降低密度。如果容器时长低估，流式处理中成对合并已有峰值并加倍每 bin 的采样数，仍不突破上限。`binsPerSecond` 必须为正且不超过采样率 8000。
- 缩略图数量为 `min(maxFrames, max(1, ceil(durationMs / 1000)))`，间隔为 `max(1000, durationMs / frames)`；`fps` 使用 `start_time=0:round=up`，短视频至少一帧，然后 `scale=-2:frameHeight` 和 `tile=Nx1` 生成一张 JPEG。默认高度 54、最多 120 帧；返回偶数帧宽并考虑视频旋转信息，排除封面图片流。
- 缓存格式版本为 1，文件名由清洗并截断到 48 字符的版本 ID、原 ID 的 SHA-256、预览种类和格式版本组成，避免目录穿越与清洗碰撞。修改格式时须递增版本常量。
- 峰值 JSON、缩略图元数据与 JPEG 均做校验；JSON 内容和 JPEG 字节分别使用 SHA-256，能够发现语法仍合法的缓存内容损坏。先写唯一临时文件再 rename，最后发布元数据；损坏或缺失项重新生成。
- `limit` 只包裹真正的生成过程，缓存命中不占执行名额；默认不限制，后续 studiod 应注入 RFC 0021 的共享本地媒体并发限制。`clear()` 先等待已有请求结算，再删除目录，新请求在清理完成后才能继续，避免已有生成任务在删除之后重新写回。
- 试编码画面最初是 128×128，低于 NVENC 支持的最小尺寸，导致装有 RTX 3070 Ti 的参考机被跳过、退回 libx264。改为 256×256 后参考机选中 `h264_nvenc`，测试固定了这个尺寸。
- 实测（参考机）：3 分钟 44.1 kHz 立体声的波形首次生成 193 ms、命中缓存 1.6 ms；60 秒 1080p 缩略图条 703 ms（纯色测试素材，真实素材在 0024c 复测）。

## 实现时的补充（0024a：剪辑节点、导出与 Agent 粗剪）

文档与校验（`packages/canvas/core/src/timeline.ts`）、导出任务（`services/studiod/src/timeline-export.ts`）、画布卡片（`packages/canvas/ui/src/TimelineNode.tsx`、`timeline-card.ts`）。

- 新建剪辑和片段的 ID 是 12 位 Crockford 随机串（取 ULID 随机部分截断）。新剪辑卡片默认 360×300，放得下 16:9 预览和下方的迷你时间线。
- `inputs` 按轨道、片段顺序取不重复的存活源节点，创建时也一样；不含剪辑自己和已删除的节点。源节点删除后文档仍可引用其素材，只是画布上不再画连线。
- `timeline.set` 同时发 `slot.revised` 和 `node.updated`，事件驱动的客户端能同时拿到文档和连线变化。登记时长不大于 0 的素材按「没有时长」处理。
- 导出读取提交时 `expectedRevision` 对应的历史版本；排队、渲染、写回期间的编辑都不算冲突。历史版本缺失或结构无效报 `timeline.invalid_doc`，素材版本或文件缺失报 `timeline.source_missing`。素材按 ID 在本项目的数据库和素材库里解析，文档里没有路径。
- 导出结果标题为「剪辑标题 · r<版本>」，剪辑没有标题时留空由界面显示默认名；剪辑在导出期间被删除时仍创建结果节点（带 `exportOf`，不连线）。
- 只有视频轨有片段时才检测 H.264 编码器，纯音频剪辑在没有可用编码器的机器上也能导出。
- 实测（参考机）：2 段 10 秒 1080p30 加 20 秒配乐，导出 2.18 s（`h264_nvenc`，不含编码器检测）。
- 卡片显示最新导出：`exportOf.timelineRevision` 最大者，相同时取画布 `z` 最大的（`NodeView` 没有创建时间）。从未导出时显示第一个视频片段的静帧；纯音频且未导出时显示片段数和时长摘要。隐藏的「工作中」节点不参与布局，但仍用于查找源节点和导出结果。
- 「创建剪辑」的排序：按垂直中心分行，一行以其第一个节点的中心为基准，中心差不超过节点高度中位数的一半才并入，避免错落的一列连成一行；行内从左到右。
- 卡片选中时下方显示版本条（片段数 · 时长），可以恢复旧版本（带 `expectedRevision` 的 `timeline.set`）；0024a 不做编辑器，也不响应双击。
- 工作审阅里的剪辑预览只在导出结果正好对应该历史版本时显示视频，否则显示该版本的摘要；只有变更里有剪辑时才读取整个画布。
- 假 Codex 场景 `timeline-roughcut` 不会把较短的配乐延长到超出素材长度，淡出也会缩短到片段之内。

## 实现时的补充（0024b：编辑器）

预览数据（`services/studiod/src/media-previews.ts`、web host `/previews/...`）、编辑模型与草稿（`packages/timeline/ui/src/model/`、`draft.ts`）、播放器与编辑器外壳（`player.ts`、`player/`、`TimelineEditor.tsx`）、宿主接线（`apps/web/src/client/timeline-editor.ts`）。

**预览数据**

- 每个项目一份预览缓存，放在项目数据目录 `cache/previews`，不进用户可见的项目文件夹。正常关闭保留缓存；删除项目时先关闭再清空，删除持久化后崩溃的恢复路径也会清空。关闭项目会拒绝新请求、中止正在进行的生成并等它们结束，再关数据库。
- 未命中缓存的生成与本地媒体任务共用全局 2 个槽位的先进先出队列，命中缓存不占槽位，同一版本同一种类的并发请求共享一次生成，预览不建任务记录。代价：两个长导出占满槽位时，预览可能等几分钟；以后可以给交互式预览预留一个槽位或单独限流。
- 图片不生成缩略图条，请求返回 `invalid_params / media.kind_mismatch`，编辑器直接用素材 URL。未知版本返回 `not_found / asset.version_not_found`。
- web host 的 `GET /previews/<spaceId>/<assetVersionId>/filmstrip?t=<token>` 与素材路由同样校验令牌，返回 `Cache-Control: private, max-age=31536000, immutable`（版本不可变）。不带 Origin 的请求放行（图片加载常常不带），明确来自别的源的请求拒绝。
- 剪辑导出现在使用配置的 ffmpeg / ffprobe 路径（0024a 遗留）。
- 实测（参考机）：3 分钟立体声波形首次 208 ms、命中缓存 1.7 ms；60 秒 1080p 缩略图条 781 ms。

**编辑与保存**

- 素材只从编辑器的素材库加入（编辑器盖住了画布，不能从画布拖入）。没有导出取消，没有「Agent 正在编辑」提示，版本历史仍在画布卡片的版本条里。
- 外部修改：用户自打开（或上次载入）后没有编辑过，就静默采用；否则显示冲突横幅，编辑停用直到「载入对方版本」。横幅用 `host.lastWriter()` 写出会话名，取不到时用通用文案；web 宿主目前不提供写入者（没有便宜可靠的来源）。提交返回冲突后，宿主会重读节点，草稿要等看到更新的已提交版本才允许载入，避免采用过期文档。
- 撤销 / 重做走本次编辑会话的修改，撤销已提交的修改会把上一份文档作为新版本提交；载入对方版本清空撤销栈。撤销 / 重做只有快捷键，没有工具栏按钮。
- 关闭、Esc、「在画布上显示」（检查器的来源链接、片段菜单、最新导出）都先等草稿提交完；提交失败或冲突时编辑器保持打开。导出先提交，再导出 `draft.baseRevision`。
- 宿主接口补充：`assetInfo(id)` 返回素材版本的时长、尺寸、版本号和种类（来自 `asset.get`，编辑器内去重缓存），源节点删除后仍能知道片段是图片；`rename(title)` 改标题；草稿带 `saveError` 显示失败原因。
- 素材时长未知前，已有片段的出点不能超过原来的范围；新加入的非图片素材等元数据到了再放，不猜时长。新图片片段默认 5 秒，切分后两边都至少 0.5 秒。
- 固定的旧版本显示为 `v<n>`，不显示原始 ID；元数据未到时不显示。最新导出显示「从 r<n> 导出」而不是时间，因为现有视图没有创建时间。
- 时间输入接受小数秒或 `mm:ss.ff` / `hh:mm:ss.ff`，`ff` 是输出帧率下的帧号。淡入淡出字段用小数秒。片段音量 0–200%，滑块旁有数字输入，100% 处有吸附。
- 没有 `doc.output` 时，时间码和逐帧步进按 30 fps（现有契约不提供源帧率）；标题栏显示「匹配首个片段」，不声称帧率。
- 吸附容差为当前缩放下 8 px，Alt 关闭吸附；音频片段的起点或终点都可以吸附。缩放范围 0.2–600 px/s，最小窗口下「适应」也能放下 30 分钟。播放时按页滚动，不做平滑滚动。
- 空剪辑显示视频行和「配乐」行作为放置目标，第一次编辑时才写进文档。Tab / Shift+Tab 在同一轨道内选相邻片段；Esc 先关弹出层，再清除选择，没有选择时关闭编辑器。
- 保存失败只对 `unavailable`、`timeout`（含连接断开）退避重试；`invalid_params`、`not_found` 等不再重试，保存状态停在「未保存」。关闭、Esc 或跳回画布时如果保存失败，编辑器里显示原因和「重试」「不保存并关闭」，放弃后画布保留最后一次提交的版本。
- 编辑器打开时画布不响应任何键盘输入（删除键、空格预览、复制粘贴等），避免误删编辑器下面仍选中的剪辑节点。点到编辑器里不可聚焦的区域时焦点回到编辑器，快捷键继续有效。Tab / Shift+Tab 只在焦点在片段上时切换片段，到头时按正常焦点顺序移动。
- 「匹配首个片段」时只改帧率，会写入第一个片段的尺寸；尺寸未知前帧率不可改。
- 预览或波形加载失败时画成纯色块，不影响编辑；`unavailable`、`timeout` 这类失败 10 秒后再次请求时重试，`not_found`、`invalid_params` 不重试。

**播放**

- 两个 `<video>` 交替：空闲的那个提前加载下一个视频片段并定位到入点。音频按片段建 `<audio>`，只为正在发声和 500 ms 内要发声的片段建，经 Web Audio 增益节点做淡入淡出和轨道音量 / 静音，改轨道音量不重建媒体源。以 `AudioContext` 时钟为准，媒体元素漂移超过 80 ms 才重新对齐。

**画布入口**

- 剪辑卡片工具栏「打开剪辑」，双击卡片也打开（取代上文「0024a 不响应双击」）。剪辑图标改为轨道上错开的片段加播放头，与分镜图标区分。打开编辑器不卸载画布，关闭后回到原来的视口，焦点回到剪辑节点。

## 实现时的补充（0024c：分镜组装、画布波形、帧率与写入者）

**组装成剪辑**（`packages/canvas/ui/src/script-table.ts` 的 `assembleScriptTimeline`）

- 脚本节点工具条「组装成剪辑」：按镜头顺序，每个镜头取最新的存活 `role: 'video'` 视频节点；没有就取最新的 `role: 'first'` 首帧图片，显示时长取 `durationSec`（四舍五入到毫秒，限制在 0.5–30 秒；为空时用服务端默认 3 秒）；两者都没有的镜头跳过。
- `node.create` 的 `content.timelineFrom` 项可以写成 `{ nodeId, durationMs }`，只对图片有效，其他种类报 `timeline.duration_image_only`。Agent 也用这种写法组装。
- 超过 200 个片段或 30 分钟时停在上限，后面的镜头都算作因上限跳过。宿主先并行读取所选视频的登记时长（按素材版本去重）再计算；时长未知的按 0 计，最终以服务端校验为准。
- 一次事务创建剪辑节点，位置由服务端摆放，创建后聚焦新节点；有跳过的镜头时提示数量和原因。没有可用镜头时按钮停用。

**画布波形**

- 音频节点和音频处理面板改用服务端 `media.preview` 的 `peaks` 和 `ui-kit` 的 `PeaksWaveform`，浏览器不再解码整段音频。按素材版本缓存，多个节点共用一次请求；失败时显示平直波形，下次挂载再请求。
- 实测 3 分钟立体声：`decodeAudioData` 调用 1 → 0，音频缓冲约 70 MB → 1.4 MB（`JSHeapUsedSize` 不含解码缓冲，比较时两项都要看）。

**源帧率**

- 视频素材版本登记时记录帧率（`avg_frame_rate`，退回 `r_frame_rate`），保留三位小数，只接受 1–240；`AssetVersionView.fps` 可选。0024c 之前的版本不回填。生成服务里 Ark 沿用已有的探测结果，渲染和 Mock 直接报告编码帧率，不额外探测。
- 「匹配首个片段」时，标题栏、时间码和逐帧步进用第一个视频片段的源帧率，未知时用 30；设置了输出帧率时以输出为准。
- 输出帧率仍是 1–60 的整数：只有符合的源帧率才出现在帧率选项里；在匹配模式下改尺寸时，源帧率四舍五入并限制在 1–60。小数帧率的时间码用整秒加整数帧号，不用丢帧记法；高帧率时帧号可能是三位数。

**写入者**

- `SlotView.writer { actor, sessionId? }` 来自写入当前版本的操作，快照里的历史版本同样适用。冲突横幅按 `sessionId` 在空间视图里找会话标题，找不到时用通用文案。

## 实现时的补充（0024c 第二部分：预览队列、性能测量与热点修复）

**预览单独排队**（`services/studiod/src/media-previews.ts`、`media-tasks.ts`）

- `media.preview` 未命中缓存时，改用独立的全局单槽 FIFO，不再与本地媒体任务的 2 个槽位共用。两个长导出占满槽位时，波形和缩略图条照常生成；本地媒体任务也不会等预览。
- 缓存命中不占槽位，同一版本同一种类的并发请求共享一次生成，预览不建任务记录，这些都不变。关闭项目只中止本项目正在生成的预览、丢弃本项目排队中的预览（返回 `media.interrupted`），其他项目的队列顺序不受影响。
- 排队和关闭时的排空抽成 `createMediaLimiter`，本地媒体任务和预览共用；`MediaTaskService.limit` 已删除。

**性能测量脚本**（`apps/web/perf/timeline.perf.ts`）

- `pnpm build && pnpm --filter @vis/web perf`，约 2 分钟。不进 `pnpm check` 和 e2e，只测量、不设失败阈值；报告写到 `/tmp/vis-perf/report-<标签>.md` 和 `.json`。
- 环境变量：`VIS_PERF_CPU_THROTTLE=4`（Chrome CPU 降速，近似最低配置）、`VIS_PERF_FFMPEG_DIR`（studiod 使用的 ffmpeg / ffprobe 目录，例如 LGPL 构建；测试素材始终用 PATH 里的 ffmpeg 生成）、`VIS_PERF_OUT`。
- 素材：10 段 6 秒 1080p30 H.264 + AAC 立体声（带噪点的 `testsrc2`，接近生成结果的码率，不是单色），3 分钟 AAC 音乐。剪辑样例 50 段和 200 段。
- 「播放到出画面」等到媒体时间前进才算，不把暂停时已经显示的那一帧算进去；「片段切换」每帧检查可见的 `<video>` 是否就绪并把画面缩到 16×9 算亮度。
- 「无关画布事件的代价」：编辑器打开和关闭时各发 20 次 Agent 移动无关文本节点的事件，按空闲基线扣除后求每次事件的主线程时间和脚本时间。总时间受样式、布局影响噪声大，判断编辑器自身开销看脚本时间。
- 内存是 macOS 上 Chrome 进程的 RSS，包含共享页，偏高，只作上限参考。studiod 空闲 CPU 在同一进程里测，进程里还有 web host 和 Playwright，也是上限。

**实测**（2026-11-02，Apple M3 Pro，12 逻辑核，36 GB，macOS，headless Chrome，`deviceScaleFactor` 2）

| 指标 | 目标 | 实测 1x | 实测 CPU 4 倍降速 |
|---|---|---|---|
| 打开编辑器（50 个片段，缓存已生成） | < 500 ms | 98 ms（中位数，含 Playwright 往返） | 177 ms |
| 拖动、缩放、滚动时间线（200 个片段） | 60 fps，单帧 < 16 ms | 60 fps，p95 16.8 ms，无长任务 | 60 fps；拖动时 1 帧 50 ms |
| 点击播放到出画面 | < 300 ms | 34 ms（最长 48 ms） | 41 ms（最长 75 ms） |
| 预览片段切换 | 不出现黑帧 | 0 / 935 帧 | 0 / 934 帧 |
| 3 分钟音乐的波形，第一次 / 有缓存 | < 2 s / < 100 ms | 238 ms / 4 ms | 220 ms / 4 ms |
| 6 秒 1080p 缩略图条，第一次 | — | 933 ms | 1.1 s |
| 导出 1 分钟 1080p30，需要重编码 | 硬件编码不慢于实时 | 11.9 s，5.0 倍实时（`h264_videotoolbox`） | 同左 |
| 导出纯拼接（`-c copy`），10 个片段 | < 5 s | 3.7 s | 3.5 s |
| 编辑器打开时渲染进程内存 | < 500 MB | 只有画布时约 950 MB，打开编辑器 +5 MB，播放后 +100 MB，关闭编辑器后不回落（JS 堆 11–19 MB） | 约 790 → 970 MB |
| 无关画布事件，每次的编辑器脚本开销 | — | 修复前约 4.5 ms，修复后约 0.6 ms | 修复前约 15 ms，修复后 6–10 ms，最后一次在噪声内 |
| studiod 空闲 CPU | ≈ 0 | 上限 0.4 %（含 web host 和 Playwright；合入 RFC 0025 前为 2–8 %） | 0.1 % |

**修掉的热点**

- **片段切换黑帧**（修复前每个切点 2 帧，`readyState` 1）：备用 `<video>` 提前对齐了下一段，但对齐记录只在发声时写入；切换时判断为未对齐，又设了一次 `currentTime`，触发重新 seek。现在对齐记录跟着媒体元素，备用元素对齐后切换不再 seek；文档改动（裁剪、移动、换素材）和真正的跳转仍会重新对齐。
- **暂停时一直占主线程**（200 段剪辑暂停时每 6 秒约 306 ms 任务时间）：播放器、时间码、播放头三个 `requestAnimationFrame` 循环一直在跑。现在只在播放时逐帧更新；暂停时靠时钟事件（播放、暂停、跳转、结束）、文档和缩放变化、媒体就绪事件（`loadedmetadata`、`loadeddata`、`seeked`、`canplay`、`error`）更新，300 ms 的加载提示改用一次性定时器。修复后约 133–145 ms / 6 秒。
- **宿主失效**：每个持久化的画布事件都让编辑器宿主拿到新的 `nodes` 数组，整个编辑器重渲染；Agent 写画布时派生的 `work.itemChanged` 还会重建 `actions`，同样让宿主失效。现在 web 宿主只把编辑器用到的节点交给编辑器（剪辑节点本身、文档里引用的来源、媒体库里的视频 / 音频 / 图片、这个剪辑的导出），成员不变时沿用同一个数组；编辑器打开期间记住出现过的来源，撤销和冲突草稿仍然找得到；`actions` 改用不随工作项变化的画布操作；写入会话的标题单独作为依赖。`TimelineEditor` 用 `memo` 包起来。`TimelineEditorHost.nodes` 的说明随之改为「可以省略无关节点，成员不变时可以沿用同一个数组」。

**LGPL ffmpeg 验证**

- 本机构建：ffmpeg 8.1.2，`--enable-shared --enable-libopenh264 --enable-videotoolbox --enable-audiotoolbox`，没有 `--enable-gpl` / `--enable-nonfree`，`ffmpeg -L` 显示 LGPL 2.1，动态链接，装在 `~/.local/ffmpeg-lgpl`（不在仓库里，不影响 PATH）。
- 结果：编码器探测在 macOS 选中 `h264_videotoolbox`；假装没有硬件编码器时（按 Linux 探测）回退到 `libopenh264`，1 分钟 1080p 导出 13.3 s（4.5 倍实时），产物是 1920×1080 H.264。纯拼接导出 3.4 s；波形和缩略图条生成正常（177 ms / 830 ms）。
- Windows 上的 LGPL 构建（`h264_mf` / NVENC 和 `libopenh264` 回退）没有在本期验证，随桌面 app 打包时再测。

**测试在 macOS 上的修正**

- 之前的验收都在 Windows 上做，macOS 上有 6 条浏览器 e2e 和 1 条单测失败：`Control+End`、`Control+A` 在 macOS 不是到文末和全选，改用 `Meta+ArrowDown` 和 `ControlOrMeta`；`Control+click` 在 macOS 是右键，多选改用 `ControlOrMeta`；两处断言在界面更新前就读值，改为 `expect.poll` 等到同样的值。产品代码已经支持 ⌘，没有改。
- Skill 的可执行位检查原来是单独一条用例，但每条用例都换新项目，文件不存在，改为在文件夹导入那条用例里检查。沙箱单测的临时目录改用 `realpath`（macOS 的 `/var` 指向 `/private/var`）。

**遗留**

- 最低配置还没在真实机器上实测。Windows 参考机的结果见下文「Windows 实测与真实 Agent 试用」。
- 渲染进程内存高于 500 MB 的目标，但只有画布时就已经这样，JS 堆很小；播放后多出的约 100 MB 关闭编辑器后不回落。Windows 上按私有字节复测的结果见下文：只释放了一部分，仍需定位。
- 画布事件本身的代价：本期测得编辑器关闭时每次无关画布事件约 10–15 ms 脚本时间（4 倍降速 45–60 ms），来自画布和应用层。合入 RFC 0025 的画布优化后复测降到约 4 ms（4 倍降速约 9 ms），不再单独跟进。
- 宿主失效修复后，编辑器打开时每次事件的总主线程时间仍比关闭时多约 5–11 ms，脚本份额已接近 0，剩下的是页面更大时的样式和布局重算。


### Canvas video posters (memory follow-up)

`media.preview` also accepts `kind: 'poster'` for video asset versions and returns `{ kind: 'poster', width, height, path? }`. It caches one JPEG frame at the start (`0.001 s`), fit within 960 × 960 without upscaling, through the same single-slot preview queue. Only the web host uses `path`; browsers request the authenticated immutable `/previews/<space>/<assetVersion>/poster` route. `CanvasViewProps.posterUrl(assetVersionId)` supplies the host-specific URL alongside `assetUrl`; desktop hosts can supply their own route later.

Idle canvas video nodes and timeline exports show a poster without a `<video>`. Hover, focus within the node, selection, or Play mounts a metadata-preloaded player; the poster stays visible until `loadeddata`, and a Play request made during mounting starts without another click. Paused players release after three seconds without hover, focus or selection; leaving the viewport releases them immediately. Playback survives hover loss. Poster errors retain the metadata-player fallback, and thumbnail-only videos use the same fallback. Full previews and media-operation panels retain their existing behavior.

The coordinator's original macOS `footprint` measurement at deviceScaleFactor 2 found 62 MB for an empty renderer, 230 MB with ten 1080p video nodes and 499 MB with thirty (about 15 MB per idle decoder), while adding thirty 2048² images cost about 45 MB. Deleting videos left 367 MB reserved until reload; the JS heap stayed below 10 MB. The before/after measurements for this change are recorded separately in the worker validation report.


## Windows 实测与真实 Agent 试用（2026-11-02）

**环境**：Windows 11，i7-12700KF（20 线程），16 GB，RTX 3070 Ti，headless Chrome，`deviceScaleFactor` 2。ffmpeg 为本机 GPL 完整构建（Gyan 9.0.2，带 libx264，不带 libopenh264）。性能脚本现在在 Windows 上同时记录渲染进程的工作集和私有字节（`PrivatePageCount`，不含共享页）。4 倍降速只减慢 Chrome 的 CPU，不代表真实的 4 核 / 8 GB 机器。

| §8 指标 | 目标 | Windows | Windows 4 倍降速 |
|---|---|---|---|
| 打开编辑器（50 段，缓存已热） | < 500 ms | 中位数 79 ms（首次 249 ms） | 中位数 233 ms（首次 828 ms） |
| 拖动 / 缩放 / 滚动（200 段） | 每帧 < 16 ms | p95 6 ms；缩放最长 29 ms | p95 6 ms；拖动最长 41 ms |
| 播放到出画面 | < 300 ms | 中位数 34 ms | 中位数 29 ms |
| 片段切换黑帧 | 无 | 0 / 2603 帧 | 0 / 996 帧 |
| 波形（3 分钟音乐）首次 / 缓存 | < 2 s / < 100 ms | 203 / 33 ms | 117 / 33 ms |
| 缩略图条（6 秒 1080p）首次 | 无 | 中位数 719 ms，首个素材约 2.85 s | 中位数 710 ms |
| 导出：重编码 1 分钟 1080p30 | 硬件 ≥ 实时 | 7.5 s（NVENC，约 8 倍实时） | 7.5 s |
| 导出：直接拼接 10 段 | < 5 s | 3.7 s | 3.7 s |
| studiod 空闲 CPU | ≈ 0 | 0.00% | 0.16% |

**内存**（渲染进程私有字节，MiB；三次运行：正常 / 降速 / 正常重复）

- 只有画布 356–376；打开编辑器 392–421；播放后 486 / 500 / 536；关闭编辑器 1 秒后 443 / 446 / 475。
- 关闭编辑器释放 43–61 MiB，但仍比画布基线多 67–119 MiB，JS 堆只有 10–20 MiB。500 MB 的目标不能算稳定达到。0024e 定叠加轨数量之前，先在 10 / 30 秒、强制 GC 和重新加载后复测，分开渲染进程和 GPU 进程，查清是哪部分没有释放，并在真实的 8 GB 机器上测多路视频同时解码。

**仍未验证**：Windows 上的 LGPL 构建、`h264_mf` 和 libopenh264 回退；首个缩略图条约 2.85 s 是冷启动还是排队造成的。

**真实 Codex 试用**（Codex CLI 0.166.0，隔离的数据目录，只有 Mock 生成服务）：五个场景各一轮，全部通过，没有工具报错，没有生成任务。

- 拼接三个镜头并加配乐、最后 2 秒淡出、导出：12 秒成片。
- 修改同一个剪辑（镜头 2 剪成前 2 秒，配乐音量 0.6）后再导出：后面的片段前移，配乐跟着缩短并保留淡出，改的是原剪辑而不是新建。
- 把分镜表组装成剪辑：按镜头顺序，用每个镜头最新的视频。
- 用户先改了剪辑（静音一条轨）再让 Agent 修改：Agent 读取最新状态后写入，保留了用户的修改。没有覆盖到写入时才发生的 `revision_conflict`。
- 要求加字幕和交叉淡化：Agent 只读取，没有编造字段，但声称可以用本地处理把字幕和转场合成进成片，这在现有本地操作里并不支持。因此三个 Agent 的剪辑说明补充了：不支持的效果要直接说明，未实际完成和校验前不要声称能做到。

## 0024d / 0024e 已确认的方向（维护者 2026-11-02）

详细设计（契约、界面、测试）在开工前补进本文。下面是已经定下的方向。

**分步**

- 先做 d，再做 e。d 拆成两块并行：「变速与转场」都改片段长度和切点，「字幕」是独立的轨道。单素材的 `audio.fade`、`audio.gain`、`audio.normalize` 沿用 0021 的本地操作，可以单独做。

**变速**

- 片段增加可选的 `speed`（暂定 0.25–4）。片段在时间线上的长度为 `(outMs - inMs) / speed`；导出声音用 `atempo`，音调不变；预览用 `playbackRate`。
- 新字段可选，文档仍是 `version: 1`，旧剪辑不迁移。

**转场**

- 交叉淡化、淡入淡出到黑作为切点属性，记在后一个片段上（暂定 `transitionIn: { kind, durationMs }`）。
- 转场让前后片段重叠，剪辑总时长相应变短，与常见剪辑软件一致。「视频轨首尾相接」的校验改为按扣除转场后的位置计算。
- 预览用两个交替的视频元素做透明度过渡；导出用 `xfade` / `acrossfade`，有转场时不走直接拼接。

**字幕与文字**

- 新增 `text` 轨，片段为文字、起止时间、样式预设和位置。导出时烧进画面，不做软字幕。
- 渲染：从文字轨生成 ASS，用 ffmpeg 的 `ass` 滤镜（libass）烧录，`fontsdir` 指向内置字体和项目字体。浏览器预览用 CSS 模拟同样的样式，加载**同一个字体文件**。换行由我们计算后写进字幕，并关闭 ASS 自动换行，使预览和导出断行一致。
- 样式用预设（例如默认、综艺花字、电影字幕、标题），每个预设规定字体、描边、阴影、位置，可单独改颜色和字号。Agent 只选预设，不写 ASS 参数。
- **内置字体**：思源黑体（Noto Sans CJK SC，默认）、得意黑（Smiley Sans）、霞鹜文楷（LXGW WenKai）、站酷快乐体。打包前逐个核对官方许可是否允许随应用分发和商用，许可证文本随应用附上。每款中文字体约 5–20 MB，数量保持克制；以后可以改为用到时再下载。
- **用户字体**：第一版支持把 `.ttf` / `.otf` 上传为项目素材，预览和导出都能使用。字体授权由用户负责，界面上提示一句。
- 语音转写生成字幕先不做。SRT 导入 / 导出待定。
- 需要确认：打包用的 LGPL ffmpeg 构建是否带 libass、freetype 和 harfbuzz；没有的话打包后无法导出字幕。

**0024d 详细设计时要定的**

- 字幕和转场的时间是相对片段还是绝对时间，片段裁剪、移动、变速时怎样跟随；转场时长怎样影响总时长和后续片段的位置。
- 给 Agent 写明「最新结果」的判定：与界面的 `shotOutputs` 一致，按节点创建时间（ULID），同时创建时再看层叠顺序；或者由服务端提供同样的组装接口，避免 Agent 按标题猜。
- `timeline.set` 的能力说明和 JSON schema 随每种新效果一起更新，未知字段仍然拒绝。
- 每种新效果补一个真实 Agent 验收场景（按 2026-11-02 试用的做法）。

**多视频轨叠加（0024e）**

- 主视频轨保持首尾相接；另加叠加轨，允许空隙。片段有固定的位置、缩放和透明度（按画面归一化），不做关键帧。
- 只含图片的叠加（Logo、贴图）对预览压力很小，可以先做；视频画中画在后。
- 叠加轨数量等 Windows 实测（含 4 倍降速）的数据出来后再定，届时一并评估服务端低清预览和代理文件。

## 0024d 详细设计

在「0024d / 0024e 已确认的方向」之上补充契约、导出、编辑器和分工；维护者的决定见 d.7。

### d.1 契约（`protocol/src/timeline.ts`）

文档仍是 `version: 1`；新字段都可选或属于新轨道类型，旧文档原样有效。服务端仍然拒绝未知字段。

**变速**

- 视频轨和音频轨的片段增加 `speed?: number`，0.25–4，最多两位小数，省略即 1。图片片段不接受（`timeline.speed_image`）。
- `inMs` / `outMs` 仍是素材内的范围。`clipDurationMs` 改为 `round((outMs - inMs) / speed)`，所有调用方自动按时间线长度计算。
- 新增 `sourceTimeAt(clip, timelineMs) = inMs + (timelineMs - startMs) × speed`，导出和预览都用它从时间线位置换算到素材位置，不再各自写 `inMs + 偏移`。
- 淡入淡出按时间线毫秒计，限制在变速后的片段长度内。
- 不做倒放和变速曲线。

**转场**

- 视频轨片段增加 `transitionIn?: { kind: 'crossfade' | 'dip', durationMs }`，表示与前一个片段之间的转场。`crossfade` 是交叉淡化，`dip` 是闪黑（前段淡到黑，后段从黑淡入）。第一个片段不能有。
- `durationMs` 为 200–2000。有转场时后一片段与前一片段重叠：`startMs = 前一片段结束 − durationMs`，剪辑总长相应变短。视频轨「首尾相接」校验改为这条规则；没有转场时与现在相同。
- 长度约束：转场不超过前后两个片段各自的长度，并且一个片段的入转场与出转场之和不超过它的长度（`timeline.transition_too_long`）。
- 重叠期间两个片段的原声自动交叉：前一片段的有效淡出、后一片段的有效淡入至少为转场时长。新增 `effectiveFades(track, index)`，导出和预览共用。

**文字轨**

- 文档增加可选的 `textTracks: TextTrack[]`，与 `tracks` 分开，最多 2 条（例如字幕和标题各一条）。`TextTrack = { id, name?, hidden: boolean, clips: TextClip[] }`。分开存放是因为现有代码遍历 `tracks` 时都假定片段有素材来源；文字片段放进去会让每个调用方都要区分类型。轨道和片段的 id 在整个文档里（包括文字轨）仍然唯一。编辑器把文字轨显示在视频轨上方。`timelineDurationMs` 计入文字片段。
- `TextClip = { id, startMs, durationMs, text, style, fadeInMs, fadeOutMs }`：
  - `durationMs` 为 200 ms 到 30 分钟。同一文字轨内不能重叠，按 `startMs` 排序。
  - `text` 为 1–200 个字符，最多 3 行。换行只来自文本里的 `\n`，不自动折行，保证预览和导出断行一致；编辑器在超出安全区时提示。
  - `style = { preset, font?, sizePct?, color?, position? }`。`preset` 为 `'subtitle' | 'variety' | 'cinema' | 'title'`；`sizePct` 是字号占画面高度的百分比（2–20）；`color` 是 `#RRGGBB`；`position` 为 `'bottom' | 'middle' | 'top'`。省略的项取预设值。
  - `font` 为 `{ builtin: 'noto-sans-sc' | 'smiley-sans' | 'lxgw-wenkai' | 'zcool-kuaile' }` 或 `{ assetVersionId }`（项目里的字体素材）。
- **时间是绝对时间**，与音频轨和 SRT / ASS 一致；数据里不记录文字属于哪个镜头。编辑时的「字幕联动」由编辑器计算（见 d.4），服务端和导出只看绝对时间。Agent 整份写回文档时自己按镜头位置计算文字的起止时间，镜头位置变了要一起调整文字。
- 文字片段计入剪辑总长。没有视频片段但有文字时，导出用黑底视频：尺寸和帧率取 `output`，省略时为 1920×1080、30 fps；文字之外的时间也是黑底，声音照常混合。

**字体素材**

- 素材类型增加 `font`（`AssetKind` = 媒体类型加 `font`，节点类型不变；字体不放上画布）。接受 `.ttf` / `.otf`，上限 50 MB，MIME 为 `font/ttf` / `font/otf`。
- 登记时解析字体的 `name` 表，记录字族名（优先英文名），写入 `asset_versions.font_family`。ASS 按字族名引用字体。
- `asset.import`（界面）和 `asset.importFile`（Agent）都接受字体。上传时界面提示：字体授权由用户负责。
- 新方法 `font.list`（ui 和 agent）：返回内置字体和本项目的字体素材，每项为 `{ font, family, label }`。

**预设**

| 预设 | 字体 | 字号 | 样式 | 默认位置 |
|---|---|---|---|---|
| `subtitle` 字幕 | 思源黑体 | 5.5% | 白字，深色描边 | 底部 |
| `variety` 综艺花字 | 站酷快乐体 | 8% | 黄字，粗深色描边加阴影 | 底部 |
| `cinema` 电影字幕 | 霞鹜文楷 | 4.5% | 白字，柔和阴影，无描边 | 底部 |
| `title` 标题 | 得意黑 | 12% | 白字，细描边 | 居中 |

预设的具体数值（描边宽度、阴影、边距）写成协议里的常量，导出和预览读同一份。

### d.2 导出（`packages/assets/src/timeline-render.ts`）

- **变速**：视频片段 `trim` 后 `setpts=(PTS-STARTPTS)/speed`；声音 `atrim` 后用 `atempo`，低于 0.5 时串两级。
- **转场**：视频轨不再一律 `concat`。从第一个片段开始逐个合并：有转场时 `xfade=transition=fade|fadeblack:duration=d:offset=该片段 startMs`，没有时 `concat`。每个片段在合并前已经统一尺寸、帧率和长度，满足 `xfade` 的要求。声音不用 `acrossfade`，继续用每个片段的 `afade` 加 `adelay` 混合，淡入淡出取 `effectiveFades`。
- **黑底**：没有视频片段但有文字时，视频链用 `color=black` 生成整段黑底，再叠文字。
- **文字**：从文字轨生成 `captions.ass`（`PlayResX/Y` 等于输出尺寸，`WrapStyle: 2` 不自动换行，淡入淡出用 `\fad`），在视频链最后、编码器滤镜之前加 `ass=captions.ass:fontsdir=fonts`。用到的字体复制到渲染临时目录的 `fonts/`。
- 本机 ffmpeg 没有 `ass` 滤镜时，含文字的导出返回 `unavailable` / `media.captions_unavailable`；结果按 ffmpeg 路径缓存，与编码器探测相同。
- 有变速、转场或文字时都不走直接拼接。
- 生成 ASS 的部分是纯函数（`captions.ts`），单独测试；`planTimelineRender` 只负责把它接进滤镜图。

### d.3 预览（`packages/timeline/ui`）

- **变速**：`playbackRate = speed`，`preservesPitch = true`。对齐、步进、播放头换算都改用 `sourceTimeAt`。
- **转场**：重叠期间两个 `<video>` 同时可见并播放，按进度设透明度（闪黑时前半段淡出到黑、后半段淡入）。图片片段之间的转场需要第二个 `<img>`。原声音量按 `effectiveFades` 做增益曲线。
- **文字**：在画面区域（含黑边计算后的实际画面）上叠一层 HTML。字号、描边、阴影按预设常量换算成 CSS（描边用 `paint-order` 加 `-webkit-text-stroke`），字体用 `FontFace` 加载与导出相同的字体文件。预览允许与导出有像素级差异，以导出为准。

### d.4 编辑器

- **变速**：检查器里给视频和音频片段加速度：0.5×、0.75×、1×、1.25×、1.5×、2× 和数值输入。片段上显示「1.5×」。视频轨改速度后波纹移动后面的片段；音频轨变长会撞上后面的片段时停在边界并提示。
- **转场**：视频轨相邻片段的切点上显示一个小按钮，点开选择无 / 交叉淡化 / 闪黑和时长。重叠部分在时间线上用斜纹表示。移动或删除片段后，变成第一个片段的入转场去掉，放不下的转场缩短到允许的最大值。
- **字幕联动**（业界通用做法，类似剪映的「联动」和 Premiere 的同步锁定），时间线工具栏上有开关，默认打开，按剪辑节点记在本地（不进文档）：
  - 每段文字归属到它的 `startMs` 所在的视频片段（落在转场重叠里时归属后一个片段）；视频轨为空或文字在视频结束之后时不归属任何片段，不受影响。
  - 在编辑器里裁剪、移动、删除、变速视频片段或修改转场，使某个视频片段的 `startMs` 改变时，归属它的文字平移同样的距离。
  - 删除视频片段时，归属它的文字一起删除，与片段删除在同一步撤销里。
  - 平移后与同轨其他文字重叠，或超出 30 分钟上限时，这次编辑整体不做，并提示原因。
  - 音频轨不联动，配乐保持原位。关闭开关后文字保持原位。
  - 联动在 `timeline-ui` 的模型里实现为纯函数，作用于编辑前后的两份文档，配单元测试。
- **文字**：文字轨显示在视频轨上方。「添加文字」在播放头处加一个 2 秒的字幕片段，可以拖动和裁剪。检查器里编辑：文本（多行）、预设、字体（内置字体、项目字体、「上传字体…」）、字号、颜色、位置、淡入淡出。预览画面里点文字可以选中对应的片段。
- 所有新文案进 `messages.ts`（中英文），新动画遵守 `prefers-reduced-motion`。

### d.5 Agent

- 三个 Agent 的剪辑说明补充变速、转场、文字轨和字体（`font.list`），并把「还不支持」改成只剩多视频轨叠加。
- 写明「最新结果」的判定：按节点创建顺序，`nodeId` 是 ULID，越大越新，与界面的 `shotOutputs` 一致。
- `timeline.set` 的能力说明和 JSON schema 随新字段更新。
- 假 Codex 增加「加字幕、转场和变速」场景供 e2e 使用；真实 Agent 验收按 2026-11-02 试用的做法，补「给每个镜头加字幕」「镜头之间加交叉淡化」「把镜头 2 放慢一半」三个场景，需维护者批准后运行。

### d.6 分工

| 部分 | 负责 | 内容 |
|---|---|---|
| 接口（协调者先提交） | Claude | 协议里的 `speed`、`transitionIn`、文字轨、`FontRef`、预设常量、`sourceTimeAt`、`effectiveFades`、`AssetKind` 加 `font`、`font.list`、错误码和文案；存储迁移（字体类型和 `font_family`）；`planTimelineRender` 的文字滤镜接入点，以及编辑器里文字轨和文字检查器的挂载点（空组件），避免两个 worker 改同一处 |
| D1 变速与转场 | Codex worker | 导出编译里的变速和转场；服务端校验；编辑器模型、播放器、检查器的速度部分、切点转场按钮；e2e |
| D2 文字与字体 | Codex worker | 字体清单与下载脚本（d.7）；`captions.ts` 与字体 `name` 表解析；studiod 的字体登记、`font.list`、内置字体路由；文字轨的服务端校验；编辑器文字轨、文字检查器、预览叠层和字体加载；e2e |
| D3 单素材音频（以后再做） | Codex worker | `audio.fade`、`audio.gain`、`audio.normalize` 本地操作（0021），与 D1、D2 无交集；维护者决定不和 D1、D2 一起做 |
| Agent 说明 | Claude | D1、D2 合并后统一更新，再做真实 Agent 验收 |

### d.7 已定（维护者 2026-11-02）

- 文字用绝对时间，编辑器提供默认打开的字幕联动。
- D3 以后再做。
- **内置字体不进仓库**：仓库里放字体清单 `resources/fonts/fonts.json`（每款的 id、字族名、文件名、固定版本的直接下载地址、SHA-256、许可证和许可证地址）。脚本 `scripts/fetch-fonts.mjs` 在安装依赖后下载到不进 git 的 `resources/fonts/files/`，校验 SHA-256，不一致就删除并报错；已有且校验通过的文件不重复下载。只下载字体文件和许可证文本，不执行任何下载内容。studiod 从 `VIS_FONTS_DIR` 读取，省略时用仓库里的这个目录；桌面 app 打包时把字体和许可证一起打进去。字体缺失时，用到它的导出返回 `unavailable` / `media.font_missing`，并提示运行脚本。
- 只有文字、没有画面时用黑底导出（默认 1920×1080、30 fps）。
- 转场先做交叉淡化和闪黑；速度 0.25–4，保持音调。


## Implementation notes (0024d, 2026-11-03)

D1 (speed and transitions) and D2 (text and fonts) were implemented in parallel on the seam above and merged together. Where these notes refine d.1–d.7, the notes win.

**Export**

- `concat` can leave the frame rate unknown, so every intermediate transition fold, including plain concatenations inside a mixed chain, reapplies the output `fps` and `settb=AVTB` before the next `xfade` consumes it. Each incoming clip's exact timeline `startMs` is the `xfade` offset.
- Source-range rounding slack grows on slowed clips: per-clip video padding is `50 / min(1, speed)` timeline milliseconds before the duration trim. Sped-up audio is padded or trimmed to its rounded timeline length before fades and delay.
- An explicit `speed` on an image clip, including `speed: 1`, is rejected with `invalid_params` / `timeline.speed_image` in both canvas and export validation.
- The ASS compiler deduplicates styles by their fully resolved values and font family; text track order sets the ASS layer and the preview paint order. Literal backslashes get a following word joiner (as FFmpeg's own ASS encoder does), so user text such as `\N` stays literal; only real newlines break lines.
- Caption exports run ffmpeg with the render directory as cwd and absolute media inputs, so the `ass=captions.ass:fontsdir=fonts` arguments stay relative ASCII paths even when the data directory contains spaces or Chinese.
- Missing `ass` filter: `media.captions_unavailable`; missing bundled font file: `media.font_missing`; a font reference that does not resolve to a project font version: `invalid_params` / `timeline.font_missing`. Font references are validated on hidden text tracks too.
- Text-only documents count as nonempty for export enqueueing and for the editor and canvas Export actions.

**Fonts**

- Noto Sans SC is the pinned static Regular OTF, not the variable font: Chrome renders the VF at weight 400 while libass picks its default weight 100, which breaks preview/export parity.
- Smiley Sans is only published as a release ZIP. `fetch-fonts.mjs` therefore has one exception: for that archive it verifies the archive and extracted-font SHA-256, inflates exactly the named entry in memory to a fixed filename, supports only stored/deflate, rejects encryption, ZIP64, multi-disk and oversized entries, and keeps no archive. Its license is fetched separately. Cache mismatches delete the file and fail; the next run downloads it again. The fetcher honours `HTTP(S)_PROXY` by restarting Node with `--use-env-proxy`.
- Public `fontFamily` (asset metadata, `font.list`, manifest) prefers the English name ID 16, then ID 1. Only the internal libass input resolves the legacy ID 1 family from the same bytes: Smiley Sans is `Smiley Sans` publicly but `Smiley Sans Oblique` to libass, and Windows libass otherwise falls back to Arial.
- Font uploads (UI and `asset.importFile`, 50 MiB limit) create font assets only, never canvas nodes, and skip ffprobe. The web host serves fonts through an authenticated route; studiod and the web host both honour `VIS_FONTS_DIR` and otherwise resolve `resources/fonts/files/` relative to their own location, not the launch cwd.

**Preview and editor**

- Speed playback uses `playbackRate` with `preservesPitch` on the existing media elements; no separate audio path is needed.
- Crossfade layers use `mix-blend-mode: plus-lighter` in an isolated frame (outgoing `1 - p`, incoming `p`) so the sum stays linear instead of darkening mid-transition; dip uses normal compositing and is black at the midpoint. Effective audio fades multiply like the sequential `afade` filters; intersecting fades use a 10 ms sampled gain ramp.
- Two video elements cannot preload a third shot while a pair overlaps, so the player adds at most one spare video (and one spare image) element when needed and reuses it for the session.
- Transition repair runs left to right after structural edits: the earlier incoming transition keeps its length and the next shrinks to what remains; below 200 ms it is removed. Splits keep the incoming transition on the first half.
- Audio speed changes pick the closest allowed hundredth that fits before the next clip and report the bound; if even 4× does not fit, the edit fails with `overlap`. Fractional-speed in-trims keep the clip end and round source bounds inward.
- Choosing a preset clears the clip's style overrides. Caption linkage is editor-local and never runs on server-originated documents or Agent writes.

**Agent and tests**

- The three Agent instructions now cover speed, transitions, text tracks, `font.list` and font imports, the newest-result rule (largest ULID `nodeId`), and state that only stacked video tracks remain unsupported.
- The browser e2e for Agent paths (`timeline-speed.e2e.ts`, `timeline-text.e2e.ts`) use scripted in-process runtimes that call the real gateway and `vis` CLI, so the shared fake-Codex fixture was not extended.

**Real Agent acceptance (2026-11-03)**: Codex CLI 0.166.0 and DeepSeek Harness, each with an isolated data directory and only the Mock provider, ran the three d.5 scenarios one after another in one session on a pre-built three-shot timeline. All six turns finished without tool errors or generation jobs. Both Agents called `font.list` before writing, exported, and checked frames themselves.

- Captions for each shot: both wrote one text track with three `subtitle` clips aligned to the shots; the 12 s exports have the text burned in.
- 0.5 s crossfades between shots: both set `transitionIn` on clips 2 and 3 and moved their starts to 3.5 s and 7 s (11 s export). Codex moved the captions with the shots; DeepSeek left captions 1–2 in place and shortened caption 3 to end at 11 s, so caption 2 runs 0.5 s into shot 3. The prompt did not ask for captions to follow.
- Slow shot 2 to half speed with captions following: both set `speed: 0.5` and moved shot 3 to 11 s (15 s export, with audio), and moved the captions with the shots.
- Claude Code acceptance is deferred by the maintainer.
- Following the second scenario, the Agent instructions now say that, unless the user asks otherwise, Agents should do what caption linkage does: move text whose start falls inside a video clip along with that clip when it is moved, trimmed, sped up or given a transition, and delete that text when the clip is deleted.

## 0024e detailed design (2026-11-03)

Builds on "0024d / 0024e 已确认的方向" above: the main video track stays continuous; overlay tracks allow gaps; clips get a fixed position, size and opacity, no keyframes; image overlays (logos, stickers) ship first, video picture-in-picture later. The maintainer's decisions are in e.8.

### e.0 Steps

| Step | Content | Depends on |
|---|---|---|
| **E1 image overlays** | Contract, validation, export, preview, editor and Agent guide for overlay tracks that accept images only | Nothing; does not decode extra video, so the memory question does not block it |
| **M memory investigation** | The re-measurement the Windows section asks for before overlay counts are set (e.6), run on the maintainer's Mac (M3 Pro, 36 GB) and, where possible, the Windows reference machine | Runs in parallel with E1 |
| **E2 video overlays (picture-in-picture)** | Overlay tracks also accept video; the limit on simultaneously visible overlay videos comes from M | M's results |

No real 8 GB machine is available yet (the maintainer's Mac has 36 GB). Unless one turns up before E2, E2 ships with at most one visible overlay video at a time, and the limit is raised only after a real low-end measurement.

### e.1 Contract (`protocol/src/timeline.ts`)

The document stays `version: 1`; old documents remain valid and unknown fields are still rejected.

- `TimelineTrack.kind` gains `'overlay'`. Overlay clips have sources, volumes, fades and speeds like other media clips, so they live in `tracks` rather than a separate array (unlike `textTracks`, whose clips have no source). Source validation, `inputs` sync, `timelineDurationMs`, "new version" and "source deleted" badges cover them without new code paths.
- Track order: the main video track, then overlay tracks from bottom to top (paint order), then audio tracks. Text tracks always draw above every overlay.
- `TIMELINE_LIMITS.overlayTracks: 2` and `overlayClipsPerTrack: 50` (bounds the filter graph in e.2; revisit after measuring). `videoTracks` stays 1 and still means the main track.
- Overlay tracks accept an optional `hidden?: boolean` (picture hidden, sound unaffected; `muted` still controls sound). Other track kinds reject it.
- Overlay clips require `overlay: { x, y, width, opacity }`; clips on other tracks reject it:
  - `x`, `y`: the overlay's centre as a fraction of the output width / height, 0–1, at most three decimals. An overlay may extend past the frame edge and is cropped there.
  - `width`: the overlay's width as a fraction of the output width, 0.02–1, three decimals. Height follows the source's aspect ratio (after rotation), so overlays are never stretched.
  - `opacity`: 0–1, two decimals.
- On overlay clips `fadeInMs` / `fadeOutMs` fade the picture as well as the sound (e.8). On the main video track they still fade only the clip's sound.
- Within an overlay track clips are sorted by `startMs` and do not overlap; gaps are allowed. No `transitionIn`. `speed` is allowed for video sources (E2) and rejected for images, as on the main track.
- **Image overlay duration**: image clips on overlay tracks may last 500 ms to `maxDurationMs`, so a logo can run through the whole film. The 30 s cap stays for images on the main track. `canvas/core/timeline.ts` and `planTimelineRender` both apply this rule.
- E1 rejects video sources on overlay tracks with `invalid_params` / `timeline.overlay_video_unsupported`; E2 removes that rule. Audio sources are always rejected (`timeline.source_kind`).
- **Output fallback**: `TEXT_ONLY_OUTPUT` becomes `FALLBACK_OUTPUT` (1920×1080, 30 fps) and applies when there is no main video clip but there are overlays or text. The picture is black underneath.
- New helpers shared by export and preview: `overlayTracks(doc)` (visible overlay tracks in paint order), `overlayOpacityAt(clip, ms)` (opacity × picture fades) and `overlayRect(clip, sourceAspect, output)` (pixel rectangle with even width and height).

**Audit**: many timeline paths branch on `kind === 'video'` and treat everything else as audio. New code uses `isMainVideoTrack`, `isOverlayTrack` and `isAudioTrack`. The contract commit covers `protocol`, `canvas/core` (validation), `canvas/ui` (card and mini timeline) and `studiod/timeline-export.ts`, and only widens types in `timeline/ui` so it compiles. E1a audits `assets/timeline-render.ts`; E1b audits `timeline/ui` and `apps/web/src/client/timeline-editor.ts`. Each feeds a document with an overlay track through the paths it owns.

### e.2 Export (`packages/assets/src/timeline-render.ts`)

- The main picture is built as now (concat / xfade, or a black `color` base). Overlays are applied after it and before captions, in track order, one `overlay` filter per clip:
  - Image: `loop=loop=-1:size=1,trim=duration=…`; video (E2): `trim` + `setpts` for speed, as on the main track.
  - Then `scale=W:H` to exactly `overlayRect`'s size (the source aspect comes from the probe, after rotation), `format=yuva420p` (keeps PNG / WebP alpha), the opacity through `colorchannelmixer=aa=…`, picture fades through `fade=t=in|out:…:alpha=1`, and `setpts=PTS-STARTPTS+start/TB` to place it.
  - `[base][ovN]overlay=x=…:y=…:eof_action=pass:enable='between(t,start,end)'`.
- Sound from overlay video clips (E2) goes through the existing audio path, using the clip and track volume and mute.
- Any visible overlay clip disables stream copy.
- Tests: `planTimelineRender` snapshot tests for argument shape, plus a real-ffmpeg test that renders a red PNG overlay on a 2 s grey picture and samples pixels before, inside and after the clip, at the expected rectangle and at half opacity. Real-ffmpeg tests skip when ffmpeg is missing, as the caption tests do.
- Measure the export time of two overlay tracks with 50 clips each on a 1-minute 1080p timeline; record it in the implementation notes. If it is much slower than real time, reduce `overlayClipsPerTrack` or switch to one composited stream per track.

### e.3 Preview (`packages/timeline/ui`)

- An overlay layer sits between the main picture and `CaptionOverlay`, inside the output frame (after letterboxing). Each visible overlay clip is an absolutely positioned element sized in percentages of the frame, so the preview matches export at any editor size.
- Images: a pool of `<img>` elements, one per overlay track plus one spare per track that preloads the next clip within 500 ms (at most 4 in E1). Opacity is set per frame from `overlayOpacityAt`, which paints only while playing and stays idle when paused, as the main player does.
- Video (E2): a `<video>` element per overlay track plus a spare, aligned with `sourceTimeAt` and the same 80 ms realignment rule. Its sound joins the Web Audio graph like other clips. The number of overlay videos playing at once is capped by the E2 limit; beyond it the preview shows the clip's poster frame and a "Preview limited" chip. Export is unaffected.
- `prefers-reduced-motion` does not change opacity fades, because they are content, not interface animation.

### e.4 Editor

- **Lanes**: overlay lanes sit between the text lanes and the main video lane, top overlay at the top, 48 px high. Clips show the image thumbnail (repeated) or the filmstrip (E2). Track header: layers icon, editable name, an eye toggle for `hidden`, and mute / volume for tracks with video clips (E2).
- **Adding**: the toolbar's "+ Audio track" becomes "+ Track" with a menu (Audio / Overlay), disabled per item at its limit. Dragging an image from the media bin onto an overlay lane adds it at the drop position with a default of `{ x: 0.5, y: 0.5, width: 0.25, opacity: 1 }` and 5 s duration (or until the next clip). The fullscreen editor covers the canvas and canvas nodes carry no drag payload (see the 0024b notes), so the media bin, which lists every image on the canvas, is the only source. While dragging an image or video, a dashed "New overlay track" row appears above the top lane while under the limit; dropping there creates the track.
- **Timeline operations**: move (free positioning, can move to another overlay lane, no overlap, as audio), trim, split, duplicate, delete, snap. Overlays are not moved by caption linkage and do not ripple; they stay at absolute times like audio.
- **Inspector** for an overlay clip: position X / Y (%), size (% of width), opacity (%), placement presets (top left, top right, bottom left, bottom right, centre, full width) with a 4 % margin, fades ("fades the picture and sound"), and, for video (E2), speed and volume.
- **Direct manipulation in the preview**: when an overlay clip is selected and visible at the playhead, the preview draws its box with corner handles. Drag to move, drag a corner to resize (aspect locked), snap to the frame centre lines and 4 % safe margins (hold Alt to bypass). Arrow keys nudge by 0.5 % (Shift: 5 %). Clicking an overlay in the preview selects it, as with text; the topmost hit wins. The edit commits on pointer up, like timeline drags.
- **Canvas card**: the mini timeline draws overlay rows with their own colour; the card itself does not change.
- New copy goes into `messages.ts` in both languages; e2e selects by `aria-label` ("Add overlay track", "Overlay X", "Overlay size", "Opacity", "Hide track").

### e.5 Agent

- The timeline guide (`workbench/core/src/instructions/guides/timeline.ts`) and Claude's `prompt.ts` describe overlay tracks, the `overlay` field with one example (a logo in the top right for the whole film: `{ x: 0.9, y: 0.1, width: 0.12, opacity: 1 }`), the image duration rule and the paint order. "Unsupported" becomes video picture-in-picture (until E2) and keyframes / motion.
- The `timeline.set` capability description and JSON schema include the new fields.
- Real Agent acceptance, with the maintainer's approval and an isolated data directory, Mock provider only: "add the logo in the top right corner for the whole film", "show this sticker on shot 2 and fade it in", "make the logo semi-transparent". E2 adds "put shot 3 in the bottom right corner over shot 1". Codex and DeepSeek; Claude Code if the maintainer resumes it.

### e.6 Memory investigation (M)

Goal: find what the renderer keeps after playback (about 67–119 MiB above the canvas baseline on Windows, not released when the editor closes) and measure the cost of each extra playing video, so the E2 limit is based on data.

- Extend `apps/web/perf/memory.perf.ts`: on macOS record the renderer's and the GPU process's footprint (`footprint` / `vmmap --summary`, physical footprint rather than RSS) through the browser PID tree; on Windows keep `PrivatePageCount`. Sample at canvas only, editor open, after playback, editor closed at 1, 10 and 30 s, after a forced GC (`HeapProfiler.collectGarbage` via CDP) and after a reload.
- Narrow the leak: heap snapshots before and after open / play / close (detached `HTMLMediaElement`, `MediaElementAudioSourceNode`, `AudioContext` that is never closed, filmstrip images, object URLs). An element connected to a `MediaElementAudioSourceNode` can stay alive with its context, so check whether the editor closes its `AudioContext` on unmount.
- Multi-decode test: a test page plays 1, 2, 3 and 4 simultaneous 1080p H.264 `<video>` elements (and 720p) for 30 s. Record renderer and GPU memory, dropped frames (`getVideoPlaybackQuality`) and main-thread long tasks, at 1× and with 4× CPU throttling.
- Output: a table in the implementation notes, any leak fix as a separate commit, and a proposed E2 limit. No new e2e timing assertions.

### e.7 Division of work

| Part | Owner | Content |
|---|---|---|
| Contract (committed first) | Claude | e.1 schema, limits, helpers, error codes and copy; server validation for image duration and `overlay_video_unsupported`; canvas card rows. E1a and E1b touch disjoint packages (`assets` vs `timeline/ui` and the web host), so no mount points are needed |
| E1a export | Codex worker | e.2 for images, unit and real-ffmpeg tests, the export measurement |
| E1b editor and preview | Codex worker | e.3 and e.4 for images, model tests, browser e2e for adding, positioning and exporting a logo |
| M | Codex worker (Mac) | e.6 measurements and leak fix |
| Agent and acceptance | Claude | e.5 after E1a and E1b merge |
| E2 | Later | Video sources on overlay tracks, using M's limit |

### e.8 Confirmed (maintainer, 2026-11-03)

All six recommendations below were accepted.

1. Overlay clip fades also fade the picture, not only the sound.
2. Two overlay tracks and 50 clips per overlay track for E1.
3. Size is a fraction of the output width with the source aspect locked, rather than a scale relative to the source size (independent of the source's resolution, so a 4K logo and a 512 px logo behave the same).
4. Overlays stay at absolute times and are not moved by caption linkage (a logo across the whole film must not move when shots change).
5. Image overlays may last up to the whole timeline.
6. Without a real 8 GB machine, E2 starts with one visible overlay video at a time.


## Implementation notes (0024e M, memory)

Measured on 2026-11-03: Apple M3 Pro, 12 cores, 36 GB, macOS 26.6.2, headless Chrome 156.0.8078.80, 1600 x 1000 at deviceScaleFactor 2. `pnpm --filter @vis/web perf memory-lifecycle` runs the standalone study; `VIS_PERF_MEMORY_ONLY=lifecycle|retention|decode` selects an experiment. It stays outside check and e2e; typecheck it with `pnpm --filter @vis/web exec tsc -p perf`.

Both tables below use physical footprint in MiB, **sum of renderer processes / GPU process**, from `footprint -p` on this browser's OS PIDs reported by CDP. Raw reports retain every PID and footprint category. Two ancillary renderers also existed; the largest renderer was 140-148 MiB at canvas, 440-485 after playback, 358-367 after GC and 158-170 after reload.

The lifecycle fixture has ten busy 6 s 1080p30 H.264/AAC sources, 50 timeline clips and 180 s AAC music. Timed samples have no forced GC until the explicit GC row; heap snapshots use a separate cycle because they trigger GC.

| Stage | 1x run 1 | 1x run 2 | 1x run 3 | 4x |
|---|---|---|---|---|
| Canvas | 226 / 118 | 230 / 342 | 231 / 342 | 236 / 143 |
| Editor open | 509 / 338 | 306 / 404 | 321 / 405 | 321 / 390 |
| After 16 s playback | 516 / 228 | 536 / 234 | 568 / 237 | 554 / 231 |
| Closed 1 s | 472 / 101 | 492 / 93 | 525 / 95 | 512 / 83 |
| Closed 10 s | 435 / 60 | 434 / 62 | 434 / 62 | 441 / 62 |
| Closed 30 s | 436 / 58 | 434 / 62 | 435 / 62 | 441 / 62 |
| Forced GC | 435 / 58 | 434 / 62 | 435 / 62 | 441 / 62 |
| Reload + 3.5 s | 235 / 178 | 241 / 76 | 242 / 73 | 244 / 177 |

The renderer sum retains about 200 MiB after close and GC. Five same-page open/play/close cycles, sampled at close +30 s and then GC, give largest-renderer footprints of **359, 339, 329, 347, 347 MiB**, with GPU 57-62 MiB. This fixed-source experiment shows a plateau rather than growth per cycle; it does not establish bounds for distinct sources or long sessions. The JS heap is only 8-17 MiB; most retained physical pages are in `app-specific tag 14`. Native renderer cache/allocator high-water retention is the leading explanation; the exact native subsystem remains unproven.

Heap snapshots and CDP WebAudio events confirm that unmount closes the AudioContext (`player.ts:78,85`): one context, three media-source nodes and six gain nodes during playback become zero after close. The editor's two videos and audio element are released, image resources return from 20 to the baseline 10, and the open/play/close cycle leaves no object URLs. The ten detached metadata videos already exist in the canvas baseline, created by `canvas/ui/src/NodeTitle.tsx:25-36`.

A quiet-window, harness-only intervention isolates that canvas cost: largest renderer / GPU is **130/108 MiB normally, 73/110 with ten metadata-video sources suppressed, and 99/107 when those sources are cleared and reloaded immediately after metadata is copied**. Early release preserves all ten dimension labels and the audio duration, saving 31 MiB in this sample. The measured fix for `NodeTitle.tsx:29-36` copies metadata, removes load/error listeners, clears the media src and calls `load()` on metadata success or error, keeping unmount cleanup idempotent. The coordinator applied that fix separately as `67eb73a`; this worker leaves canvas and timeline UI unchanged.

Each decode case uses a fresh browser, 1-4 visible muted videos, and 30 s playback of a looping 6 s local ffmpeg fixture. Chrome reports `VideoToolboxVideoDecoder` and platform decoding for every stream. Quality counters include startup; raw reports include elapsed time and individual counters. All 16 cases have **zero main-thread long tasks**.

| Source | Videos | 1x renderer / GPU | 4x renderer / GPU | Dropped/frames 1x | Dropped/frames 4x |
|---|---|---|---|---|---|
| 1080p | 1 | 225 / 102 | 226 / 101 | 0/897 | 0/897 |
| 1080p | 2 | 335 / 103 | 332 / 108 | 0/1793 | 0/1793 |
| 1080p | 3 | 451 / 114 | 471 / 124 | 0/2688 | 0/2694 |
| 1080p | 4 | 552 / 126 | 550 / 119 | 0/3586 | 0/3586 |
| 720p | 1 | 150 / 98 | 146 / 97 | 0/900 | 0/905 |
| 720p | 2 | 189 / 101 | 186 / 104 | 3/1800 | 4/1810 |
| 720p | 3 | 228 / 107 | 226 / 105 | 7/2700 | 10/2722 |
| 720p | 4 | 270 / 110 | 267 / 111 | 11/3600 | 12/3660 |

The early 1x 1080p cases with 1, 2 and 3 videos and both metadata baselines were replaced by quiet-window reruns after the other worker's e2e ended at about 10:35 UTC; the release intervention also ran in that quiet window. Lifecycle and repeated-cycle memory runs overlapped development load. Raw directories are `/tmp/vis-perf/memory-2026-11-03T10-19-48.033Z`, `/tmp/vis-perf/memory-2026-11-03T10-27-32.079Z`, and `/tmp/vis-perf/memory-2026-11-03T10-44-08.785Z`; consolidated results and provenance are in `/tmp/vis-perf/rfc-0024e-memory-report.md` and `memory-consolidated.json`.

**E2: keep one simultaneously visible overlay video.** This Mac comfortably decodes the main picture plus one overlay in isolation, including at 4x CPU throttling; this does not qualify an 8 GB machine or the complete overlay editor. On real low-end hardware retest memory pressure, weaker/software decoders, main-track crossfades plus overlay and preload spares, Web Audio, editor interaction, 1080p versus 720p, many distinct sources, and repeated open/close over longer sessions. CPU throttling does not emulate reduced RAM or GPU/decoder limits.

Validation: `pnpm build` and the standalone perf typecheck passed; the unchanged full `pnpm check` passed with `VITEST_MAX_WORKERS=1` and an isolated `TMPDIR` (2216 passed, 23 skipped). Default parallel runs exposed an existing global temporary-directory assertion collision and one Chrome-close hook timeout; no assertions or product code were changed. Measurement invocations passed 4 lifecycle, 19 supplemental and 6 quiet-rerun/intervention cases. The coordinator owns the two full e2e rounds on the merged branch.

## Implementation notes (0024e E1, image overlays, 2026-11-03)

E1a (export), E1b (editor and preview) and M (memory) ran in parallel on the contract above and were merged together. Where these notes refine e.1–e.8, the notes win.

**Export**

- Each overlay image is looped on the output frame clock (`fps`, `settb=AVTB`) and its timestamps start at the output frame where the clip begins, so fades are evaluated on the same frames the encoder writes, including clip starts between frames.
- FFmpeg's `overlay` with `eof_action=pass` lets the base through one frame early once the overlay stream ends. Each overlay stream is held one extra frame (`tpad=stop=1`) and visibility comes from a half-open `enable` interval, so an image covers exactly `[startMs, end)`. Covered by real-ffmpeg tests at 24, 30 and 60 fps.
- The probe already reports rotated dimensions, so the source aspect is used as probed.
- Overlay rectangles are composited on a 4:2:0 base: an odd `x` or `y` from `overlayRect` lands one pixel up or left. Kept, since the preview is approximate anyway; not worth a 4:4:4 pipeline.
- Stream copy is also disabled when hidden clips make the timeline longer than the main track, which would otherwise export a shorter film.
- Not yet exercised at runtime: fractional source frame rates on overlays (images only in E1) and rotated still images.
- Export time, 1-minute 1080p30 timeline with two overlay tracks of 50 distinct PNGs each, `h264_videotoolbox` on the maintainer's Mac (M3 Pro): 31.2 s (about 1.9× real time), measured under load from other workers and before the final one-frame correction. Meets the hardware ≥ real-time target; the 50-clip limit stays.

**Editor and preview**

- Overlays are added from the media bin only (e.4); dragging an image shows the dashed "New overlay track" row while under the limit.
- The preview keeps two `<img>` elements per visible overlay track (current and the next clip within 500 ms) and paints opacity only while playing.
- Implicit odd source dimensions are rounded to even output pixels in the preview as in export.
- Inspector fields follow the existing editor style (monospace inputs and selects).

**Memory (M)** — details in the section above.

- After playback the renderer keeps about 200 MiB more than the canvas alone, released only by a reload. Five open–play–close cycles in one page plateau at 359/339/329/347/347 MiB after GC, with the editor's `AudioContext` closed and its media and audio nodes gone, so this is native high-water retention, not a per-cycle leak. Recorded as a baseline; no editor fix.
- The canvas kept one detached `<video>` per video node alive for its title metadata. Releasing it on `loadedmetadata` / `error` (67eb73a) saves about 31 MiB with ten 1080p video nodes; labels are unchanged.
- Four simultaneous 1080p H.264 videos: renderer 552 MiB, GPU 126 MiB, no dropped frames and no long tasks, also under 4× CPU throttling; worst 720p case dropped 0.37 %. E2 still starts with one visible overlay video until a real 8 GB machine is measured (e.8).

**Tests**: the render cleanup tests used to compare the shared system temp directory and failed when other test files rendered in parallel; they now use a private `TMPDIR` and check the render used it (e88e23b).

**Validation on the merged branch**: `pnpm check` (2257 passed), `pnpm build`, and two consecutive full e2e rounds (202 passed, 7 caption tests skipped because the local ffmpeg has no ASS filter).

**Still open**: real Agent acceptance for overlays (e.5, needs the maintainer's approval), E2 video picture-in-picture, and a real 8 GB machine.

### Real Agent acceptance (0024e E1, 2026-11-03)

Approved by the maintainer. `pnpm --filter @vis/web agent-eval --agents codex,deepseek --scenarios O1,O2,O3` with an isolated data directory (`/tmp/vis-eval-0024e-data`), Mock and local render providers only. Codex CLI 0.166.0; DeepSeek through dsh (ACP profile).

| Scenario | Codex | DeepSeek |
|---|---|---|
| O1 logo in the top right for the whole film, then export | overlay pass; export † | overlay pass; export † (see below) |
| O2 sticker on shot 2, centred below the middle, 0.5 s fade-in | pass (5 calls, 56 s) | pass (5 calls, 32 s) |
| O3 make the logo half transparent | pass (5 calls, 50 s) | pass (4 calls, 26 s) |

- Every overlay check passed, and the video, audio and caption tracks stayed unchanged in all six runs. Placements written: Codex O1 `{0.9, 0.1, 0.12, 1}`; DeepSeek O1 `{0.9, 0.14, 0.12, 1}`; O2 `{0.5, 0.65, 0.25}` / `{0.5, 0.7, 0.18}` at 1000–2000 ms with a 500 ms fade-in.
- † The fixture has captions, and this machine's FFmpeg has no ASS filter, so `timeline.export` returns `media.captions_unavailable` (as in RFC 0026 T1). To check the overlay export itself, all six agent-written documents were re-rendered with `renderTimeline` without their text tracks: all six encoded, and sampled frames show the logo in the top right, the sticker centred below the middle and the half-transparent logo.
- Codex reported the export failure and stopped. DeepSeek spent 47 calls (300 s) working around it: it hid the captions, exported, burned the captions itself with PIL and ffmpeg, imported that file and bound it to the export node, then restored the captions. The final timeline was correct, but the export node now holds a hand-made file. While searching for a working FFmpeg it also read its own dsh profile config (`~/.dsh/profiles/acp/*.yml`, no secrets) and searched an unrelated repository under `~/.cache`. Its attempts to read `app.db` and the studiod run directory were blocked by the sandbox.
- Follow-up: the timeline guide should tell agents that `media.captions_unavailable` is an environment problem to report, not to work around by producing their own export.

## 0024e E2 detailed design: video picture-in-picture (2026-11-03)

Builds on e.1–e.8 and the E1 implementation notes. E2 lets overlay tracks hold video clips. Everything not mentioned here works as for image overlays.

### E2.1 Contract and validation

- No schema change. Overlay clips already carry `inMs` / `outMs` / `speed` / `volume` / fades, and overlay tracks already have `muted` / `volume`.
- `canvas/core/timeline.ts` and `planTimelineRender` drop `overlay_video_unsupported`; the error code and its copy are removed. Video clips on overlay tracks follow the main-track rules: the source range must fit the source duration (`timeline.source_range`), `speed` within `TIMELINE_LIMITS.minSpeed`–`maxSpeed`, and the source needs a video stream (`timeline.video_missing`). Audio sources stay rejected (`timeline.source_kind`).
- Sound: an overlay video clip's sound plays at `clip.volume × track.volume`, silenced by `track.muted`. `hidden` hides the picture only; to silence a picture-in-picture, mute its track or set the clip volume to 0.
- Fades on overlay video clips fade the picture and the sound (as for images in E1, plus the sound).

### E2.2 Export

- Overlay video chain: `trim=start=…:end=…`, `setpts=(PTS-STARTPTS)/speed`, `fps=${fps}`, `settb=AVTB`, the same clone pad as the main track (`tpad=stop_mode=clone:stop_duration=…`), `trim=duration=${length}`, then the E1 chain from the output-frame-clock `setpts` onwards (scale to `overlayRect`, `yuva420p`, opacity, `tpad=stop=1`, alpha fades, shift to `startMs`, half-open `enable`).
- Sound goes through the existing audio branch (`atrim` / `atempo` / volume / `afade` / `adelay`), now for overlay tracks too. Hidden overlay tracks still contribute sound.
- Stream copy is disabled whenever any overlay track has a clip, hidden or not, so a hidden picture-in-picture never loses its sound.
- The source aspect comes from the probe (rotation applied), as for images.
- Export draws every overlay video; the preview limit (E2.3) does not apply.

### E2.3 Preview

- Each overlay track keeps two slots (the current clip and the next one within 500 ms). A slot shows an `<img>` for an image clip or a `<video>` for a video clip; a slot switches element type only when its clip changes.
- Overlay videos are aligned with `sourceTimeAt` and the 80 ms realignment rule, and their sound joins the Web Audio graph with clip and track gain, track mute and fades, exactly like main-track clips. The alignment and gain code moves out of `player/media.ts` into a shared helper rather than being copied.
- **Limit**: at most `PREVIEW_OVERLAY_VIDEOS = 1` overlay video plays at a time (a `timeline/ui` constant, not part of the contract). When more are visible, the topmost one plays; the others pause on their current frame, stay silent, and the preview shows a "Preview limited" chip (`role="status"`, text explains that export includes every overlay). While paused or scrubbing, every visible overlay video seeks to its exact frame, so positioning still works.
- The spare `<video>` loads and seeks to the next clip's first frame, as on the main track. Releasing a slot pauses it, removes `src` and calls `load()` so the decoder goes away (see the NodeTitle fix in the M notes).
- Loading and unavailable states include overlay videos (the 300 ms "Loading" rule and the error chip).

### E2.4 Editor

- Overlay lanes accept videos from the media bin; the dashed "New overlay track" row also appears while dragging a video. Main-track video drops are unchanged.
- Placing a video on an overlay lane: `inMs` 0, `outMs` the source duration, shortened to the gap before the next clip on that lane; placement default `{ x: 0.5, y: 0.5, width: 0.25, opacity: 1 }`, as for images.
- Trim, split, duplicate, delete, move and speed edits follow the main-track video rules for source bounds; overlays still never ripple and are not moved by caption linkage.
- Overlay video clips draw a filmstrip like main-track clips. Overlay track headers gain mute and volume controls (the same controls as audio tracks), shown on every overlay track.
- Inspector for an overlay video clip: the placement fields and presets from E1, plus speed and volume as on the main track; the fade label reads "fades the picture and sound".

### E2.5 Agent

- The timeline guide and Claude's `prompt.ts` say overlay tracks take images and videos; a video overlay is picture-in-picture and keeps its sound unless the track is muted or the clip volume is 0. "Unsupported" becomes rotation, cropping and keyframed motion.
- Acceptance scenario O4: "put shot 3 in the bottom right corner during shot 1, about a third of the frame wide, without its sound, keep the main track, then export". The O4 fixture has no captions, so the export can run on an ffmpeg without the ASS filter.

### E2.6 Division of work

| Part | Owner | Contents |
|---|---|---|
| Contract and validation | Claude | E2.1 in `canvas/core`, error copy, RFC |
| E2a export | Codex worker | E2.2, plan tests, a real-ffmpeg picture-in-picture test (pixels and sound), the export time of a 1-minute 1080p timeline with one overlay video running throughout |
| E2b editor and preview | Codex worker | E2.3 and E2.4, model tests, browser e2e |
| Agent and acceptance | Claude | E2.5 after E2a and E2b merge |

## Implementation notes (0024e E2, video picture-in-picture, 2026-11-03)

E2a (export) and E2b (editor and preview) ran in parallel on the validation change above and were merged together. Where these notes refine E2.1–E2.6, the notes win.

**Export (E2a)**

- Video overlays use the main track's opening (`trim`, speed `setpts`, `fps`, `settb`, clone pad, `trim=duration`) and then share the E1 tail (output-frame clock, scale, alpha, opacity, one-frame hold, fades, `enable` interval), so image and video overlays differ only in their first filters.
- Overlay video sound goes through the existing audio branch; hidden tracks keep their sound, image overlays stay silent. Any overlay clip, hidden or not, disables stream copy.
- Real-ffmpeg tests sample pixels before, inside and after a red picture-in-picture, compare audio levels inside and outside it, and repeat at speed 2 to check the timeline end.
- Export time, 1-minute 1080p30 main track plus a 1080p30 overlay video with sound for the whole minute, `h264_videotoolbox` on the maintainer's Mac (M3 Pro): 9.0 s (about 6.6× real time).

**Editor and preview (E2b)**

- The alignment and Web Audio gain code moved from `player/media.ts` to `player/playback.ts` and is shared by the main player and a new overlay controller (`overlay/media.ts`); the main player's tests are unchanged.
- Each overlay track keeps two slots that switch between `<img>` and `<video>` when their clip's kind changes. A slot that preloaded the next clip keeps it through a gap, so it does not reload when the clip starts.
- `PREVIEW_OVERLAY_VIDEOS = 1`. While playing, the topmost visible overlay video plays; the others freeze silently and the preview shows "Preview limited · Export includes every overlay". Hidden overlay videos still play for their sound and do not count towards the limit. While paused or scrubbing, every visible overlay video seeks to its exact frame.
- Splitting sped-up overlay clips keeps both outer ends and the neighbouring clips exact; inner source points may round inwards by a few source milliseconds (covered at 2.06×).
- Overlay tracks show mute and volume in the header; the inspector adds speed and clip volume for overlay videos.
- Preview sound was checked by unit tests (gain, mute, fades, release), not by listening.

**Agent**

- The timeline guide and Claude's prompt describe picture-in-picture (sound, `hidden` versus `muted`, a bottom-right example, the one-video preview limit). Both also say that an export blocked by the local environment, such as `media.captions_unavailable`, is reported to the user and never replaced by a self-made file (the DeepSeek O1 finding above).
- O4, approved by the maintainer: "put shot 3 in the bottom right during shot 1, about a third wide, silent, keep the main track, then export", on a caption-free fixture.

| Agent | Result | Calls | Time | Written |
|---|---|---|---|---|
| Codex | pass (placement, main track unchanged, export) | 5 | 58 s | overlay track muted, clip volume 0, `{0.8, 0.8, 0.33, 1}`, 0–1000 ms |
| DeepSeek | pass (placement, main track unchanged, export) | 26 | 120 s | overlay track muted, clip volume 0, `{0.83, 0.83, 0.33, 1}`, 0–1000 ms |

DeepSeek inspected its export frames with ffmpeg, nudged the placement, exported again and deleted its first export node; it also listed running processes while looking for the MCP server. The Mock shots are nearly identical solid colours, so exported frames show the picture-in-picture only faintly; placement accuracy is covered by the E2a pixel tests.

**Validation on the merged branch**: `pnpm check` (2288 passed, 21 skipped), `pnpm build`, and two consecutive full e2e rounds (204 passed, 7 caption tests skipped because the local ffmpeg has no ASS filter).

**Still open**: a real 8 GB machine before raising `PREVIEW_OVERLAY_VIDEOS`; Claude Code acceptance for steps d and e.

## Implementation audit and ffmpeg requirement (2026-11-05)

Steps a–c, d (speed, transitions and text) and e/E2 (image and video overlays) are implemented in `protocol/src/timeline.ts`, `assets/src/timeline-render.ts`, `timeline/ui/src/` and the studiod timeline services, with plan/real-ffmpeg tests and the `timeline*.e2e.ts` suites. Earlier “Still open” notes are dated snapshots; E1 real Agent acceptance and E2 subsequently shipped as recorded below them.

Timeline export now probes `ffmpeg -version` before source probing or rendering, sharing the in-flight result and cache per executable path for the daemon lifetime. A recognized release below 7 fails with `unavailable`, reason `media.ffmpeg_version_unsupported`, and `{ version, required: 7 }`; background media tasks retain the reason as `error.code` and the full version-bearing message. Chinese and English author-facing messages name both versions. Unknown/git builds are allowed to run. After updating an already-rejected executable, restart visCreative to refresh the cached check, as the localized message explains. Missing tools retain the existing processing failure path. A repository search found no other `-/filter_complex` caller requiring this guard. There is no existing media-tool diagnostics surface, so no settings page or new startup RPC was introduced.

Still outstanding: a real minimum-spec/8 GB machine before raising the one-overlay-video preview limit; a Windows LGPL ffmpeg build; Claude Code real acceptance for d/e; single-asset audio operations (D3, intentionally separate). The known intermittent timeline source-edge failure still needs a failing diagnostic capture; this audit does not claim it fixed. Author-selected edits and selections remain under the existing revision/gateway rules.
