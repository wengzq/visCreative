# 0007 · 生成服务配置与火山方舟

状态：已决定

日期：2026-10-27

依赖：[0002](0002-sqlite-storage.md)、[0003](0003-core-contracts.md)、[0004](0004-runtime-and-agent-entry.md)。本轮接入方舟图片与视频生成，保留内置 `mock`、`render`；设置页面见 RFC 0006；不增加模型探测或真实供应商自动测试。

## 配置与密钥

全局配置位于 `VIS_DATA_DIR/providers.json`，由 `ProviderConfigSchema` 校验。更新先校验完整内容，再写临时文件并原子替换；该文件是配置的事实来源，空间 SQLite 不复制一套可编辑配置。文件不存在时使用空服务列表和内置默认值；格式错误不静默回退。

```json
{
  "providers": [
    {
      "id": "ark",
      "type": "volcengine-ark",
      "label": "火山方舟",
      "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
      "imageModels": [{ "id": "ep-your-image-endpoint", "label": "我的图片模型" }],
      "videoModels": [{ "id": "ep-your-video-endpoint", "label": "我的视频模型" }],
      "audioModels": []
    }
  ],
  "defaults": {
    "image": { "provider": "ark", "model": "ep-your-image-endpoint" },
    "video": { "provider": "ark", "model": "ep-your-video-endpoint" }
  }
}
```

- 模型 ID 使用用户在方舟开通的模型或推理接入点 ID；名称仅供显示，不预置或猜测可用模型。
- `baseUrl` 缺省为上述北京地址。只允许 HTTPS；本机 `localhost`、`127.0.0.1` 可用 HTTP 以便离线假服务验证。URL 禁止用户名、密码、查询参数和片段。
- 服务 ID 不可重复或包含 CR、LF、NUL，`mock`、`render` 为保留值；同一服务内模型 ID 不可重复。默认模型必须存在于对应服务的同类模型列表。内置合法选择为图片 `mock/mock-image-1`、视频 `mock/mock-video-1` 或 `render/html`，音频 `mock/mock-music-1`（Mock 音乐）或 `mock/mock-sfx-1`（Mock 音效）。
- `defaults.image`、`defaults.video`、`defaults.audio` 可省略，沿用内置默认服务。提交显式选择服务而未选择模型时，使用该服务对应媒体类型的默认模型。
- Key 仅存 macOS Keychain，service 为 `vis-creative.provider`，account 为 provider ID。配置和任务快照均不得存 Key；非 macOS 平台不退回明文文件。测试用可注入的内存 SecretStore。
- 调用 `/usr/bin/security` 时 Key 经标准输入传入交互命令，不进入进程 argv。Key 不进入命令行、日志、空间数据库、幂等记录、Agent 工具或返回值。

## RPC 与通知

`providers.list` 可由界面和 Agent 调用，其余方法仅界面可用。配置更新、设置和清除 Key **严格不接受 `requestId`**，也不经过空间 `idempotency_keys`。整份配置替换本身可重复执行；Keychain 是密钥的唯一持久化位置。

```ts
providers.list({}) => {
  providers: {
    id: string
    type: 'mock' | 'render' | 'volcengine-ark'
    label: string
    baseUrl?: string
    hasKey: boolean
    models: {
      id: string
      label: string
      kind: 'image' | 'video' | 'audio'
      paramsSchema: Record<string, unknown> // JSON Schema，含 default / enum / description
    }[]
  }[]
  defaults: { image?: { provider: string; model: string }; video?: { provider: string; model: string }; audio?: { provider: string; model: string } }
}

providers.update({ config: ProviderConfig }) => /* 同 providers.list */
providers.setKey({ providerId: string, apiKey: string }) => { providerId: string; hasKey: boolean }
providers.clearKey({ providerId: string }) => { providerId: string; hasKey: boolean }
```

成功变更配置或 Key 后，向已连接界面推送 `events.providersChanged`，参数 `{}`。这是瞬时通知，不占空间事件 `seq`、不落库、不进入 `afterSeq` 重放。客户端收到或重连后重新调用 `providers.list`，不依赖通知恢复事实状态。现有 `events.transient` 流式文本形状不变。

Agent 的 MCP 工具为 `providers_list`，CLI 命令为 `vis providers list`。生成前先读列表，依据 `kind` 和 `paramsSchema` 选择模型与参数；Key 的管理接口不向 Agent 暴露。

## 输入、映射与任务恢复

`generation.submit` 的事务、槽位引用固定和交付绑定语义保持不变。Job 在提交时将非敏感服务配置写入 `job.params.providerConfiguration`；随后修改或删除服务、地址和模型只影响新 Job。旧 Job 在重启后按快照重建适配器，Key 每次按原 provider ID 读取当前 Keychain；清除 Key 可能使旧 Job 无法继续访问服务。

原提示词与输入仍保留。提交外部请求前，跳过空白文本和与原提示词完全相同的文本输入，将其余文本按输入顺序追加，每段前加“参考：”；重复参考保留，文本本身不修剪。最终提示词最多 3000 个 Unicode 码点，实际发出的提示词持久化为 `job.params.actualPrompt`。图片参考读取已固定的本机素材并转为 data URI，总图片输入最多 10 MiB；图片生成最多 10 张参考图，视频生成最多 9 张。不把本机路径发给方舟，不接受视频参考输入。

### 图片

`POST <baseUrl>/images/generations`，同步响应。`model`、最终 `prompt` 原样映射；固定 `response_format: 'url'`、非流式。

| 本地参数 | 默认与限制 | 方舟字段 |
|---|---|---|
| `size` | 默认 `2K`；`1K` / `2K` / `4K` 或正整数 `宽x高`（各 2–5 位） | `size` |
| `n` | 默认 1，本地保守上限为 4；是最大数量，实际可少于该值 | 1 时 `sequential_image_generation: 'disabled'`；大于 1 时为 `'auto'`，并设 `sequential_image_generation_options.max_images` |
| `watermark` | 默认 `false` | `watermark` |
| 图片输入 | 单张为字符串，多张为数组 | `image`，data URI |

同步成功时将返回 URL 及尺寸等信息先写入本机任务记录，再让 Runner 下载并登记素材。图片结果仅支持 URL。图片 URL 有效期为 24 小时，应及时下载；持久化 URL 可在重启后继续下载，但不会延长有效期。产物少于请求上限时沿用 `missingOutputIndexes`，不自动补生成。

### 视频

`POST <baseUrl>/contents/generations/tasks` 创建任务；随后 `GET <baseUrl>/contents/generations/tasks/<id>` 查询。查询接口见[方舟官方文档](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh)。`content` 含文本提示词和图片的 `image_url` 项。

| 本地参数 | 默认与限制 | 方舟字段 |
|---|---|---|
| `n` | 固定 1，默认 1 | 一次只建一个任务 |
| `ratio` | 可选；`16:9` / `4:3` / `1:1` / `3:4` / `9:16` / `21:9` / `adaptive` | `ratio` |
| `resolution` | 可选；`480p` / `720p` / `1080p` / `4k` | `resolution` |
| `duration` | 可选；`-1` 或 2–30 的整数秒 | `duration` |
| `generateAudio` | 可选布尔值 | `generate_audio` |
| `seed` | 可选；-1–2147483647 的整数 | `seed` |
| `cameraFixed` | 可选布尔值 | `camera_fixed` |
| `watermark` | 默认 `false` | `watermark` |
| `imageMode` | 默认 `auto`；另可选 `first_frame` / `first_last` / `reference` | 图片项 `role`，见下 |

可选字段省略时交给模型决定；并非每个模型支持表中每个组合，方舟仍负责模型级能力校验。本地不提供 `fps` 参数。

#### 按模型收窄的参数

适配器的 `paramsSchemaFor(kind, model)` 按方舟模型能力表收窄参数，`providers.list` 的每个模型返回各自的 `paramsSchema`，提交时也按它校验；不支持的值在本地以 `invalid_params` 拒绝，不发请求。模型名去掉日期后缀后匹配（核对于 2026-10 的方舟文档）：

| 模型 | 收窄 |
|---|---|
| `doubao-seedance-2-0` | `resolution` 480p / 720p / 1080p / 4k；`duration` 4–15 |
| `doubao-seedance-2-0-fast`、`doubao-seedance-2-0-mini` | `resolution` 480p / 720p；`duration` 4–15 |
| `doubao-seedream-5-0-pro`、`doubao-seedream-5-0-flash` | `n` 固定 1（不支持组图） |

未登记的模型和 `ep-` 接入点沿用上面的通用范围。图片 `n` 为 1 时不发送 `sequential_image_generation`：不支持组图的模型连 `disabled` 也会拒绝。节点上保存的旧参数若已不被模型接受（例如收窄前选的 1080p），界面显示与 Agent 未显式传参的提交都会丢弃出错的字段、由默认值补上；显式传入的非法参数照常报错。Seedance 2.0 的音频参考见下表；本地仍不接受视频参考输入。

- `auto`：单张图片标记 `first_frame`，多张均为 `reference_image`；没有图片则为文生视频。
- `first_frame`：必须恰好一张，标记 `first_frame`。
- `first_last`：必须恰好两张，按输入顺序标记 `first_frame`、`last_frame`。
- `reference`：至少一张，全部标记 `reference_image`。

任务 ID 在创建成功后持久化。查询状态 `queued` → `pending`，`running` → `running`，`succeeded` 读取 `content.video_url`，`failed` / `expired` / `cancelled` → `failed`。视频 URL 同样按 24 小时有效期及时下载。

### 音频与音频参考（0012）

音频生成第一期使用内置 Mock：`mock-music-1` 的 `duration` 为 5–60 秒、默认 10；`mock-sfx-1` 为 1–10 秒、默认 2。两者合成 PCM16 单声道 22050 Hz WAV，提示词决定音高与节奏。`audioModels` 默认空数组，旧配置无需改动；可以配置方舟音频模型与默认选择，但 Seed-Audio 真实适配待邀测文档，提交时返回清晰的 `invalid_params`。

参考音频核对于 2026-10-29 的[方舟官方创建视频生成任务文档](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)：

| 本地输入 | 限制 | 方舟字段 |
|---|---|---|
| 音频素材 | 只对 `doubao-seedance-2-0` 系列开放，其他模型（含未知 `ep-`）本地 `invalid_params` | `content` 项的 `type: 'audio_url'`、`role: 'reference_audio'` |
| 音频文件 | WAV / MP3；单文件最多 15 MB | `audio_url: { url: 'data:audio/wav;base64,...' }` 或 `data:audio/mp3;base64,...` |
| 音频数量与时长 | 最多 3 个，每个 2–15 秒，总时长不超过 15 秒 | 逐项追加到 `content` |
| 多模态组合 | 不允许仅音频参考，至少同时提供一张图片（本地未接视频参考）；不能混用首帧/首尾帧模式，auto 将图片标为 reference_image；完整请求最多 64 MB | 图片沿用现有 `image_url` 项 |

固定素材版本的时长、格式与数量在占额前校验，发送前检查文件大小和完整请求体大小；直接调用适配器且缺少时长时再探测文件。测试只使用本机假 HTTP 服务，未调用真实方舟；实际模型组合仍需维护者批准后验证。

### 不确定结果

每个 Attempt 的本机任务记录位于 `VIS_DATA_DIR/ark/<编码后的幂等键>.json`。发出请求前先写 `submitting`；收到明确成功后原子替换为图片产物引用或视频任务 ID。Runner 重启优先使用已有记录恢复。

方舟没有可依赖的提交幂等保证。本机记录可阻止同一 Attempt 再发一次请求，但不能证明远端未执行。网络断开、超时、无法确认是否接受的响应，以及重启后只剩 `submitting` 的情况，均为结果未知：Job 保留 `unknown`，不自动重提。仅 HTTP 429 且包含已知限流、过载或配额错误码、没有任务 ID 或产物数据的明确拒绝可按暂时错误重试；未知或格式不完整的 429、所有 5xx 提交响应均为未知。其他明确 4xx 拒绝为失败。保留供应商错误 code/message，但先脱敏 Key、编码后的 Key 和 Authorization/Bearer 内容。不要用新的 `requestId` 或新 Attempt 自动绕过 `unknown`，否则可能重复生成和收费。

工具连接超时可以用原 `requestId` 重读本地首次回执；这不会重新提交远端任务。已经得到 `unknown` 时，应向用户说明状态，而非自动再生成。

查询与下载只读且免费，暂时失败（断网、超时、5xx）时连续失败次数超过 `maxRetries` **并且**持续超过 `queryFailureWindowMs`（默认 12 小时）才判定 `unknown`（`retries_exhausted`）；明确的 4xx 拒绝（如 Key 失效）重试无用，仍只按次数。只按次数时退避总共约 2 分钟，合上笔记本让机器在睡眠与短暂唤醒间切换就会放弃一个其实已在生成的付费视频。

已拿到外部任务 ID、因 `retries_exhausted` 停下的 `unknown` 在任务视图带 `recheckable: true`，可用 `generation.recheck` 回到 running 继续查询原任务：不重新提交、不新建 Attempt、不占并发、不计当日额度，交付仍按修订号校验。节点提醒与右键菜单提供“重新查询”。

## 人工冒烟步骤

以下步骤供开发者选择执行；自动测试仅使用假 HTTP 服务和内存密钥存储，本轮未调用真实方舟或修改真实 Keychain。

1. 在 macOS 启动本机 studiod。通过界面身份的 RPC 连接调用 `providers.update` 写入完整配置，用自己已开通的模型 ID 替换示例占位符。确认 `providers.json` 无 Key，缺省地址补全，`providers.list` 返回正确的名称、媒体类型、参数默认值和 `hasKey: false`。
2. 通过界面连接以密码输入交互收集 Key，再调用 `providers.setKey`；不要把 Key 写入 shell 命令、argv、脚本、配置或日志。确认只返回 `{ providerId, hasKey: true }`；另一界面收到 `events.providersChanged` 后重新读列表。Agent 调用设置或清除 Key 应返回 `forbidden`。
3. 在有效 Agent 回合执行 `vis providers list`，按其 ID 提交单张图片。等待任务完成，检查画布回填、本地素材和 `actualPrompt`；再用一个图片槽位作参考验证 data URI 输入。需要多图时设 `n: 2`，允许实际产物少于上限。
4. 提交一段短视频并等待回填；分别用一张首帧、两张 `first_last`、`reference` 参考图验证映射。检查可播放的本地文件与时长。计费步骤仅在开发者主动选择时执行。
5. 提交任务后重启 studiod，确认已有图片引用或视频 ID 可恢复查询和下载。运行中更换默认服务，确认新 Job 使用新选择，旧 Job 继续使用提交时的服务快照。
6. 用本机假 HTTP 服务模拟响应丢失或中途退出，确认任务停在 `unknown`，没有第二次外部提交。确认带 URL 凭据、非本机 HTTP、无效默认模型、重复 ID、配置内 Key 和密钥 RPC 内 `requestId` 均被拒绝。
7. 调用 `providers.clearKey`，确认 Keychain 条目移除、列表变为 `hasKey: false`；重连后仍能靠 `providers.list` 得到正确状态。恢复内置默认值再结束试验。

## 未决项与验证边界

- 各实际模型支持的分辨率、时长、音频及参考图组合，仍需协调者在用户同意后按上述步骤验证；目录描述的是适配器接受范围，不代表每个模型都支持全部组合。
- 本轮不实现非 macOS 密钥存储；供应商配置单测不操作真实 Key。N2 的 macOS 隔离回归会创建和删除测试专用服务的假条目。
- 24 小时过期的产物 URL 无法靠本机记录续期，未知提交也不能自动补生成；需要用户确认远端结果后决定下一步。
- 本机 Ark 任务记录暂不自动清理，清理策略须兼顾恢复窗口和问题追溯。

网页界面现通过顶栏“生成服务设置”（Cmd/Ctrl+,）及提示词面板“管理生成服务…”管理配置与密钥，交互详见 RFC 0006“生成服务设置与模型选择”。

## Agent 进程的密钥隔离（N2）

Codex 放开 shell 后，单靠 API 不返回 Key 或 run 目录 0700 不够：Agent 与 studiod 是同一 UID。macOS 下整个 app-server 及其 MCP/shell 后代由 Seatbelt 包裹，禁止向 securityd/SecurityServer 等服务查询，并禁止读取用户和系统 Keychains 目录、数据目录 run/、providers.json、app.db* 和各空间 space.db*。子进程环境用白名单构造，不继承 studiod 的密钥、令牌；vis MCP 只获得当前 Agent 实例令牌。批准工具不会移除外层隔离。studiod 本身在外层沙箱之外，仍可正常读取 Keychain。

2026-10-27 的真实 Codex 模型 shell 及 macOS 集成测试仅查询 `vis-creative.provider.test` 的唯一假 account，读取被拒，finally 删除成功；测试也覆盖假 studiod.token、另一个假令牌与环境哨兵。没有查询生产 `vis-creative.provider`、没有读取凭据文件，也没有请求方舟。系统根证书改由公共 `/etc/ssl/cert.pem` 提供，缺少该文件或 sandbox-exec 时退回只读并提示。

保证不包括 CODEX_HOME：协调确认整个真实目录可读写，Codex 自身凭据不受此隔离。任务 D 已用 npx 缓存 dsh 0.2.1-rc.2 完成独立真实对话，采用与 Codex 共用的外层策略，假钥匙串、两个令牌、环境哨兵、app.db/space.db/providers.json 全部被隔离后开放工具。素材 blobs、派生媒体、项目技能可只读访问，保持 vis 返回路径的原有用法；不允许工作区外写入。详细审批、路径例外与实测范围见 RFC 0005。


任务 D 同样不查询生产 `vis-creative.provider`，只用 `vis-creative.provider.test` 假条目并在 finally 删除，未调用方舟。dsh 自己的 `~/.dsh`（含凭据）明确可读写，Agent shell 也能访问；应用只启动 dsh，不打开其中的凭据文件。`DEEPSEEK_API_KEY` 是 dsh 环境白名单的唯一额外密钥变量，原样透传、不解析、不记录、不保存；其他父进程密钥和令牌不继承。dsh 内层 danger-full-access 仅用于避免重复 Seatbelt，不取消外层保护。实测 SSL_CERT_FILE 足以支持 dsh 登录与 Node HTTPS；无需 NODE_EXTRA_CA_CERTS。该版本 vis MCP 不发起单次审批，直接调用行为与 N2 前相同；gateway 的调用方与活动回合限制保持不变。

## 费用护栏与取消（任务 O）

`providers.json` 增加 `limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 }`，旧配置缺省补全；每个值为非负整数，0 表示不限制。设置页可编辑。服务类型非 mock/render 均按付费计算，每个 Job 算一次任务，和产物数量 n 无关。

配额是**所有项目共享**的：app.db 的 generation_quota 保存任务、项目、本地日期、媒体类型、`by_agent` 与并发占用，space.db 保留任务本身。接受任务时在全局写事务内只检查并占 Agent 的当日额度；界面提交仍记录总用量但不计入每日上限，也不会被每日上限拦截；取消、失败、unknown 不退回每日计数。并发不足时任务保留 queued 并显示“排队中（并发上限）”，开始前原子占用并发，终态释放。重启在恢复任何任务前完整扫描所有项目的未结束付费任务，重建占用；读取失败中止启动，不能漏算。

Agent 每日限额拒绝为 `quota_exceeded`，含 kind/count/limit，错误同时写会话 notice，并在 developer instructions 明确要求停止、告知用户，不换参数重试。`overrideQuota` 已删除；界面无需确认超额。迁移前的账本记录按界面提交处理，升级当天可能多出已用的 Agent 额度。最大并发仍约束所有付费任务。

`generation.usage` 的 image/video/audio 显示全部付费提交，agent.image/video/audio 显示 Agent 提交数。顶栏显示今日全局用量，面板列出今日任务状态及所属项目。取消不会抹去任务或用量；两个数据库之间若在全局占额后、空间提交前崩溃，可能留下保守占额，直到次日仍计数但没有任务明细。宁可少用额度，也不自动补发付费任务。

mock 支持取消；render 终止渲染子进程。方舟官方[取消或删除视频生成任务 API](https://docs.volcengine.com/docs/ark/cancel-or-delete-video-generation-tasks-api?lang=zh) 提供 `DELETE /contents/generations/tasks/{id}`：仅 queued 可取消，running 不支持，已结束任务的删除只删除记录。适配器先查询，只对 queued 发 DELETE 并确认取消；图片及已运行的视频停止本地后续处理，`providerCancelled: false` 如实表示服务端可能继续计费。自动测试仅使用 mock 和本机假方舟 HTTP 服务，没有调用真实方舟。
