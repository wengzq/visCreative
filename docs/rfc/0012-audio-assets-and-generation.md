# 0012 · 音频素材、音乐与音效生成，以及只约束 Agent 的生成上限

状态：第一期已实现并验证（2026-10-29）；第二期 Seed-Audio 待邀测文档

日期：2026-10-29

基于 [0001-assets](0001-assets)、[0007](0007-generation-providers.md)（生成服务）与 [0010](0010-workspaces-without-canvas-binding.md)。

## 背景

画布现在只认识图片和视频：`MediaKind` 只有两种，素材探测只读画面流，服务配置只有 `imageModels` / `videoModels`，每日上限也只分图片和视频。用户无法上传音乐、音效，也无法配置和使用音乐、音效生成模型；方舟视频的 `generateAudio` 只能随视频出音轨。

本期范围（2026-10-29 与维护者确认）：

- 做：音频上传、画布音频节点、音乐与音效生成（第一期 mock，第二期火山 Seed-Audio）、Seedance 2.0 以音频为参考生成视频。
- 不做：语音合成（TTS / 配音）和音色选择，之后和镜头节点一起设计；音视频合成、剪辑、混音。

## 决定

**音频是第三种媒体，不拆成「音乐」「音效」两种。**`MediaKind`、`NodeKind`、`CanvasNodeKind` 增加 `audio`。音乐与音效由模型和提示词区分：同一个模型（如 Seed-Audio）往往能出两者，拆类型会让默认模型、上限、选择器都多出一套而没有实际收益。界面在模型选择器里用模型名区分，例如「Mock 音乐」「Mock 音效」。

### 契约

| 位置 | 变化 |
|---|---|
| `common.ts` | `MediaKind`、`NodeKind`、`CanvasNodeKind` 加 `audio` |
| `asset.ts` | `AssetVersionView` 不变：音频有 `durationMs`，没有 `width` / `height` |
| `providers.ts` | `ProviderDefaults` 加 `audio`；`GenerationLimits` 加 `dailyAudio`（默认 20）；方舟服务加 `audioModels`（默认空数组，旧配置文件照常读取） |
| `rpc.ts` 等 | 所有写死 `['image', 'video']` 的地方改用 `MediaKind` |
| storage | `kind` 列的 TS 枚举加 `audio`；SQLite 无 CHECK 约束，`db:generate` 应无新迁移，有则提交生成结果 |

### 素材

- 上传与 `asset.import` / `asset.importFile` 接受 `.mp3`、`.wav`、`.m4a`、`.aac`、`.ogg`、`.flac`（`audio/mpeg`、`audio/wav`、`audio/mp4`、`audio/aac`、`audio/ogg`、`audio/flac`）。
- 探测改为看流而不只看扩展名：有画面流按图片 / 视频处理（与现在相同）；只有音频流的文件为 `audio`，读取时长；两者都没有返回 `invalid_params`。`.webm`、`.mp4` 只含音轨时也登记为音频，mime 改为对应的 `audio/*`。
- SVG 图片（`.svg`、`image/svg+xml`）不经 ffprobe：只接受不超过 10 MiB 的 UTF-8 文本与 `<svg>` 根元素，拒绝 DOCTYPE / ENTITY；宽高优先读取根元素数字或 px 值，再回退到 viewBox，缺失时省略。SVG 可能包含 Agent 生成的脚本，素材响应统一设置 sandbox CSP 与 nosniff，避免直接打开素材时在应用同源执行；界面仍只通过图片展示，不栅格化、不抽帧。SVG 不可作为方舟参考图，提交在本地返回 `invalid_params`「SVG 不能作为方舟参考图，请先导出为 PNG」；mock/render 保持支持。
- 专辑封面流（`disposition.attached_pic=1`）不算画面；有音轨且除封面外没有画面流时仍为音频。
- 图片扩展名只接受图片内容，音频扩展名只接受音频内容；不符时返回 `invalid_params`「文件内容与扩展名不符」。`.mp4` / `.m4v` / `.mov` / `.webm` / `.mkv` 可为视频或纯音频，纯音频时 MIME 改为对应 `audio/*`。
- 音频素材不支持 `asset.extractFrames`，返回 `invalid_params`。
- 波形不入库：前端用 Web Audio `decodeAudioData` 解码后算峰值，按 `assetVersionId` 缓存在内存。素材不可变，所以缓存永不过期；解码失败只显示一条平线，不影响播放。

### 画布音频节点

- 默认尺寸 360 × 140，可缩放；内容为波形、播放 / 暂停、进度拖动、当前时间 / 总时长。同一时刻只播放一个节点，开始播放另一个时前一个暂停。
- 其余与图片、视频节点一致：版本历史、「作为参考生成」、模型与参数选择、生成中 / 失败状态、删除。空节点显示提示词输入与生成按钮。
- 播放进度条与波形动画在 `prefers-reduced-motion` 下不做过渡动画；播放本身不受影响。
- 键盘：节点选中时空格切换播放（不在输入框内时）。按钮都有 `aria-label`（「播放」「暂停」「播放进度」）。
- 上传入口 `accept` 增加 `audio/*`，文案改为「上传图片、视频或音频」。

### 生成

- `generation.submit` 的 `kind: 'audio'` 走与图片、视频相同的作业、幂等、取消、复查流程；产物交付到音频节点或新建音频节点。
- 每日上限按 `dailyAudio` 计数，规则见下一节。
- **mock**：内置 `mock-music-1`（「Mock 音乐」）与 `mock-sfx-1`（「Mock 音效」），在代码里合成 WAV（PCM 16-bit 单声道 22.05 kHz），不新增依赖。音高与节奏由提示词哈希决定，同一提示词结果稳定；参数 `duration`（音乐 5–60 秒，默认 10；音效 1–10 秒，默认 2）。e2e 与单元测试只用 mock。
- 服务设置里方舟服务可以填写音频模型，默认音频模型可选 mock 或已配置的音频模型；未配置时界面的音频生成默认用 mock 并标明「Mock」。

### 每日上限只约束 Agent

过去每日上限对所有付费任务计数，用户在界面碰到上限时弹「超过每日生成上限」确认后用 `overrideQuota` 继续。实际上它只拦住了 Agent（gateway 本来就禁止 Agent 超额），对用户只是多一次确认。2026-10-29 与维护者确认改为：

- **界面提交的付费任务不受每日上限约束，也不计入上限。**删除 `overrideQuota` 参数（`generation.submit` / `regenerate`）、`QuotaConfirmation` 对话框与 `actions.ts` 里的超额重试；界面不再收到 `quota_exceeded`。
- **Agent 提交的付费任务**（含 Agent 的重试）按 `dailyImage` / `dailyVideo` / `dailyAudio` 分类型计数，到上限返回 `quota_exceeded`，并照旧在会话里写一条通知；Agent 应停下告诉用户，由用户在设置里调高。`0` 表示不限。
- 计数口径：全部项目共用，按本地日期；只数 Agent 提交的。app.db 账本 `generation_quota` 增加 `by_agent` 列（`db:generate` 生成迁移），旧记录视为界面提交——升级当天 Agent 额度可能多出已用的部分，可以接受。占额检查与写入仍在同一个写事务里。
- `maxConcurrent`（最大并发）不变，对所有付费任务生效：它防的是服务商限流，不是花费。
- mock 与 render 仍不计数。
- 界面文案：设置里的三项改为「Agent 每日图片上限」「Agent 每日视频上限」「Agent 每日音频上限」，说明「只限制 Agent 提交的付费生成；你在界面上的生成不受限制。0 表示不限」。顶栏用量显示今日全部付费提交数（图片 / 视频 / 音频），用量详情里另列 Agent 已用 / 上限。
- Agent 开发者说明（Codex、DeepSeek、Claude 的 `prompt.ts`）去掉 `overrideQuota` 的说法，保留「遇到 quota_exceeded 就停下告诉用户，不要换参数重试」。

### Seedance 2.0 音频参考（第一期）

0007 已记录 Seedance 2.0 支持参考视频与音频、本地暂只接图片。这次接上音频：

- 视频生成的输入可以包含音频节点；`ProviderInput` 已带 `kind`，音频输入随之传入适配器。
- 方舟适配器把音频输入作为 `content` 中的音频项，`role` 为参考音频。**字段名、是否接受 base64 data URL、时长与数量限制，实现前须按方舟官方「创建视频生成任务」文档核对**并写回 0007 的表格；文档拿不到时适配器先不发送音频项、在本地以 `invalid_params` 提示「所选模型暂不支持音频参考」，不猜字段。
- 只有登记为支持音频参考的模型（`doubao-seedance-2-0` 系列）接受音频输入，其他模型本地拒绝，不发请求。
- 真实调用验证需要维护者批准，按 0007 的验收步骤在隔离数据目录进行。

### Agent

- `vis` CLI 与 MCP 工具的 kind 参数接受 `audio`；生成、引用、导入音频与图片视频相同。
- Agent 听不到音频。读到音频节点或素材时给出元数据：时长、mime、生成来源（提示词、模型、参数）。开发者说明（`prompt.ts`）补一句：音频只能按元数据和提示词判断，不要声称听过。

## 第二期：火山 Seed-Audio

维护者选择优先接火山 Seed-Audio 1.0（豆包音频生成模型）。截至 2026-10-29，它的 API 在方舟邀测，公开资料里的接口地址、鉴权、同步还是异步、参考音频字段都不完整，有的示例使用 `openspeech.bytedance.com` 而不是方舟域名。因此：

- 第二期在维护者拿到邀测资格和官方接口文档后再写适配器，不按二手资料猜接口。
- 如果它走方舟（同一个 Key、`/contents/generations/tasks` 风格），作为方舟服务的 `audioModels` 接入；如果是独立服务或不同鉴权，`ProviderConfigSchema` 的服务改为按 `type` 区分的联合类型，新增一种服务类型，Key 照旧只存钥匙串。
- 第一期的 `audio` 类型、节点、上限、默认模型设置都按这两种可能留好位置，不需要再改契约。

## 不做

- 语音合成、音色、对白分轨。
- 把音频合成进视频、裁剪、淡入淡出、多轨混音。
- 后台抽波形或转码；只存原始文件。

## 验收

- `pnpm check` 通过；`pnpm build` 后完整 e2e 连续两轮通过。
- 新增 e2e：上传一个 wav 生成音频节点并能播放 / 暂停；用「Mock 音效」生成音频节点；把音频节点连到视频节点后提交（mock 视频服务）作业带上音频输入。
- e2e：上限设为 1 时，界面连续生成两次都成功且不弹确认。
- 单元测试：界面提交不计数也不被拦；Agent 提交按类型计数并在上限返回 `quota_exceeded`；`overrideQuota` 已从契约移除；只有音轨的 mp4 探测为音频；音频不能抽帧；mock 音频同一提示词结果一致；方舟适配器对不支持音频参考的模型本地拒绝。
- 两份 README（中英）与路线图更新；0007 补音频相关表格。
