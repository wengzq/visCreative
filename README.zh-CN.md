<p align="center">
  <img src="docs/images/banner.svg" alt="visCreative — 多 Agent 创作空间" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

<p align="center">
  <img alt="Node.js 24+" src="https://img.shields.io/badge/node-%E2%89%A524-3c873a?logo=nodedotjs&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white">
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-%E4%BA%8B%E5%AE%9E%E6%9D%A5%E6%BA%90-0f80cc?logo=sqlite&logoColor=white">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-10-f69220?logo=pnpm&logoColor=white">
  <img alt="测试" src="https://img.shields.io/badge/%E6%B5%8B%E8%AF%95-4100%2B%20%E5%8D%95%E6%B5%8B%20%C2%B7%20392%20e2e-2ea44f">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

<p align="center">
  审美归你，Agent 带来所有工具。<br>
  一张共享画布，Agent 通过正式接口和你一起写作、绘制、渲染和剪辑。一切都有版本、可溯源，而什么算好由你决定。
</p>

<p align="center">
  <a href="https://everythingviscreative.com"><b>everythingviscreative.com</b></a> · <a href="#试用桌面预览版">桌面预览版</a> · <a href="#快速开始">快速开始</a>
</p>

---

<p align="center">
  <img src="docs/images/zh-CN/hero.webp" alt="visCreative 网页界面：画布上有分镜脚本节点、手绘风关键帧（选中的一张带版本条和节点工具栏）、剪辑节点，右侧是 Codex 会话" width="100%">
</p>

## 原则

**机制归产品，提议归 Agent，决定归作者。** visCreative 做好创作所需的基础，并把 Agent 接入其中。审美和思考留给你：这正是优秀创作和普通创作最大的区别。

- **Agent 提方案，你来选。** 遇到开放的创作选择，Agent 给出几个不同方向并说明理由，而不是一个“最佳答案”。
- **你的作品归你。** Agent 只能对你写的内容提修改建议，不能替换你画的画格。删除你的文字、清理它派生的子工作区，都要你亲手确认。这些由网关强制执行，不靠提示词。
- **没有固定流程。** 分镜表、镜头预演和其他流程都是可选项，你可以跳过。
- **不在背后揣测你。** 什么算好由你来定：把你的做法告诉 Agent，读过草稿，再存成自己的 Skill。

## 亮点

|  |  |
| --- | --- |
| 🧑‍🤝‍🧑 **多 Agent，一张画布** | 在同一个空间里并行运行多个 Agent 会话（Codex 和 DeepSeek Harness；Claude Code 可选，真实 Agent 验收尚未完成）。每个会话有自己的记录，画布共享。 |
| ✍️ **写作的地方** | 任何文本节点都能打开成完整的文稿页：章节大纲、类似 Obsidian 的实时预览、可渲染可编辑的表格、带版本历史的自动保存，支持导入 TXT、Markdown 和 DOCX。Agent 用锚定的修改建议和你协作，由你接受或拒绝；选区或章节可以拆成分镜，并和原文保持关联。 |
| 🧍 **可交互 3D 场景** | 生成之前先把镜头摆出来：放置可摆姿势的人偶、道具和你自己的 `.glb` 模型，保存有名字的机位，再把机位存成图片或发送到预演画格。关节可在限位内旋转，也可以从预设姿势开始，或把一侧镜像到另一侧；还能用键盘微调物体和关节。场景可以独立存在，用不用都行。 |
| 🎥 **镜头预演** | 用压感画笔绘制画格，或导入自己的图，一个镜头可以有多格；再让 Agent 用代码渲染免费的白模预演。预演和付费生成是两个阶段：白模画面只有在你点确认后才会成为构图参考。 |
| 🧠 **你的 Skill，你的方式** | 把你的做法告诉 Agent，它用你的话起草 Skill，由你编辑和保存。版本不可变，每个项目保留固定副本，什么时候更新、发布、重置或加入新项目都由你决定。 |
| 💬 **读得下去的会话** | 连续的思考和工具调用折叠成一个工作块，生成的图片和视频以结果卡片展示，**立即发送**可以让排队消息插到当前回合之前。 |
| 🗂️ **工作项与看板** | 把目标交给根工作区里的 Agent，它会拆成若干子工作项派发下去，每项有自己的工作目录和 Agent 会话；画布节点和资产由整个项目共享。进度显示在「待办 / 进行中 / 待审阅 / 已完成」看板上；提问汇到跨项目收件箱；每一项都经你审阅改动后才算完成。看板是你的：卡片可以拖到任意一列，不要求理由。 |
| 🗑️ **最近删除** | 在项目切换菜单中删除项目，会停止 Agent 和生成任务，画布、历史与文件保留，可在设置 › 最近删除中恢复。永久删除会清理应用数据，另有默认不勾选的项目目录删除选项，并检查危险目录。 |
| 🧭 **Agent 通过正式接口工作** | 每项能力只在协议注册表里声明一次，再以 `vis` 命令行和 MCP 服务的形式提供给 Agent。画布和数据库修改经正式接口完成；隔离后的 Codex 还可以读写自己的工作区文件。 |
| 🎞️ **生成结果自动回家** | 任务幂等、重启后可恢复；结果写回它本该去的那个画布槽位，并做修订号校验，不会悄悄覆盖更新的内容。 |
| 🕰️ **生成过的东西绝不丢** | 每个槽位保留完整的修订历史。悬停窥视旧版本，点击对比，再“设为当前”或“另存为节点”——不用花钱重新生成。 |
| 🔗 **看得见的来龙去脉** | 虚线表示结果由哪些节点生成而来；实线表示生成节点下一次将要使用的参考输入。 |
| ↩️ **尊重他人的撤销** | 你自己的画布操作可以撤销，刷新后依然有效。如果 Agent 或生成结果之后改过同一处，这一步会被拒绝，而不是覆盖他们的成果。 |
| 🎨 **接入真实服务，同样安全** | 内置 Mock 和本机代码渲染（HTML/anime.js/three.js → 图片或视频），另支持火山方舟、可灵、OpenAI 图片、阿里云百炼（万相）、MiniMax 和 Gemini。方舟和 MiniMax 已通过真实接口验证，其余服务在通过验收前，应用里都标为未验证。API 密钥只存在 macOS 钥匙串或 Windows 凭据管理器中。 |
| 🎬 **从分镜到成片** | 一个分镜脚本节点装下整张镜头表和出场角色；按镜头生成首帧和视频，再用 **组装剪辑** 进入全屏剪辑器：裁切、变速、转场、字幕、徽标与画中画叠加、配乐。导出经 ffmpeg 渲染成普通视频节点。 |
| 🎵 **画布上的音频** | 上传音频，在波形节点中播放、拖动进度，或用 Mock 生成音乐与音效。音频沿用图片、视频的版本历史、参考输入和生成流程。 |
| 🎥 **视频参考** | 用画布片段引导 Seedance 2.0 和已注册的 Seedance 2.5。提示词面板提前显示封面、时长、模型限制与托管状态；媒体托管使用你自己的 TOS 存储桶。 |
| 📚 **资产库** | 点顶栏的 **资产库** 按类型、分类和标签浏览项目里的素材。你发起后，项目的资产库会话为素材起名、分类、打标签（手改的字段始终优先，每轮整理都能撤销），并建议把同一主体的素材归成设定——人物、场景、物品和风格——经你确认后生效。素材可以直接拖到画布上；在脚本编辑器里可以从资产库选设定入镜。把项目设为系列的一集，就能在各集之间共享设定：每集保留自己固定版本的副本，只在你选择时才更新。 |
| 🖱️ **像工具一样顺手的画布** | 带模型与参数选择的浮动提示词面板、⊕ 快速延伸、右键菜单、复制/粘贴/创建副本、下载、小地图、可收起的会话面板。 |

## 细节一览

示例制作：动画系列「山海少年」第一集「晨光」。所有画面都在本机渲染，Agent 对话全部是脚本化的；`pnpm --filter @vis/web readme-shots` 可以重新生成这些截图（见[开发](#开发)）。

<table>
  <tr>
    <td colspan="2"><img src="docs/images/zh-CN/writing.webp" alt="《晨光》写作页：章节大纲、Markdown 即时预览与渲染后的三列表格"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>写作页</b>——章节大纲、即时预览与可编辑表格，让文稿集中在一处；从任意文本节点打开写作页。</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/zh-CN/writing-review.webp" alt="Agent 锚定在开场段落的修改建议，显示原文、替换文字以及接受和拒绝按钮"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>建议由你决定</b>——Agent 把建议留在对应段落旁，只有你接受后，原文才会改变。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/zh-CN/previz.webp" alt="画布上的镜头预演卡片：两幅手绘画格、白模构图标记和本机渲染的白模预演行"></td>
    <td width="50%"><img src="docs/images/zh-CN/previz-editor.webp" alt="全屏画格编辑器：手绘山脊与提灯人物、两个画格和运镜备注"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>镜头预演</b>——每个镜头可画多格；先审阅免费的本机白模预演，再决定是否采用白模画面作为构图参考。</sub></td>
    <td align="center"><sub><b>画格编辑器</b>——在全屏工作区里绘制、导入、排序并添加运镜备注，画作由你掌控。</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/zh-CN/scene-editor.webp" alt="3D 场景编辑器：一个人偶摆出指向姿势，选中的右肩上有旋转手柄，右侧是预设姿势、镜像和关节列表" /></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>3D 场景</b> — 摆好人偶、道具和机位，再把画面存成图片或送到预演画格。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/zh-CN/skills.webp" alt="设置中的我的 Skill：已保存的叙事方法，以及标有有新版本可用和已在此项目修改的项目副本"></td>
    <td width="50%"><img src="docs/images/zh-CN/skill-draft.webp" alt="Agent 会话中的作者叙事方法，以及带审阅和丢弃按钮的待决定 Skill 草稿卡片"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>我的 Skill</b>——保存自己的方法，每个项目保留固定版本副本；何时更新、重置或发布本地改进，由你决定。</sub></td>
    <td align="center"><sub><b>从对话到 Skill</b>——让 Agent 按你描述的方法起草，审阅后再决定是否加入自己的 Skill。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/zh-CN/turn-view.webp" alt="会话中的工作块、本机渲染的铜灯视频结果卡片，以及带立即发送按钮的排队消息"></td>
    <td width="50%"><img src="docs/images/zh-CN/cleanup-card.webp" alt="子工作区清理审批卡片：声音与剪辑工作项、删除影响，以及删除和保留按钮"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>读得下去的会话</b>——工作步骤折叠，结果独立可见；用立即发送让新指示插到当前回合之前。</sub></td>
    <td align="center"><sub><b>清理由你确认</b>——Agent 可以请求清理自己的子工作区，由你决定；画布内容与素材保留。</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/zh-CN/script.webp" alt="分镜脚本编辑器：五个镜头，含时长、转场、画面描述、景别、运镜、人物和场景"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>分镜脚本</b>——一个节点装下整张镜头表。从资产库选人物和场景入镜；负责的 Agent 写首帧和视频提示词，批量生成补齐每个镜头。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/zh-CN/script-cast.webp" alt="分镜设定：人物参考图、描述及镜头使用情况"></td>
    <td width="50%"><img src="docs/images/zh-CN/script-prompts.webp" alt="分镜提示词：每个镜头单独保留首帧和视频提示词"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>参考设定</b>——人物、描述和参考图集中管理。</sub></td>
    <td align="center"><sub><b>镜头提示词</b>——每个镜头单独保留首帧和视频提示词。</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/zh-CN/timeline.webp" alt="全屏剪辑器：素材栏、带字幕和系列徽章的预览，以及字幕、徽章叠加、视频片段和配乐轨道"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>剪辑器</b>——字幕、徽标叠加、1.5 倍速和交叉淡化的片段、带波形的配乐。预览与导出一致。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/zh-CN/timeline-assemble.webp" alt="分镜脚本节点连到剪辑节点，剪辑节点再连到导出的视频"></td>
    <td width="50%"><img src="docs/images/zh-CN/timeline-inspector.webp" alt="剪辑器中选中一个视频片段，检查器显示入点出点、速度预设、片段音量和淡入淡出"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>分镜 → 剪辑 → 成片</b>——组装剪辑取每个镜头的最新视频；导出结果作为普通视频节点回到画布。</sub></td>
    <td align="center"><sub><b>片段检查器</b>——为选中的片段调整入出点、保持音调的变速、音量和淡入淡出。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/zh-CN/library-media.webp" alt="资产库素材页：音频、图片、视频按类型和分类分组，可按标签筛选"></td>
    <td width="50%"><img src="docs/images/zh-CN/library-settings.webp" alt="资产库设定页：两个角色带系列版本、系列有新版本、本地已修改徽章，以及本集还没用的系列设定"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>资产库素材</b>——你发起后，资产库会话为素材起名、分类、打标签；手改的始终优先。</sub></td>
    <td align="center"><sub><b>设定与系列</b>——每集保留系列人物、场景和风格的固定版本副本，只在你选择时更新。</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/images/zh-CN/board.webp" alt="工作看板：导演工作项和它的子工作项分布在待办、进行中、待审阅、已完成四列，其中一个 Agent 在等待回复"></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><sub><b>工作看板</b>——导演派发了四项任务：一项等你回答，一项待审阅，一项已完成。运行名额跨项目共享。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/zh-CN/review.webp" alt="工作项审阅抽屉：Agent 的完成报告和改动关键帧的前后对比"></td>
    <td width="50%"><img src="docs/images/zh-CN/inbox.webp" alt="收件箱：一个带回复框的 Agent 提问，和一份带审阅按钮的完成报告"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>审阅抽屉</b>——Agent 的报告，以及这一轮新增或修改的每个节点。通过，或打回（意见可选）。</sub></td>
    <td align="center"><sub><b>收件箱</b>——所有项目的报告和提问集中在一处，直接回复，或打开审阅。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/zh-CN/versions.webp" alt="查看关键帧的旧版本，可设为当前或另存为节点，上方是节点工具栏"></td>
    <td width="50%"><img src="docs/images/zh-CN/context-menu.webp" alt="图片节点的右键菜单"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>版本历史</b>——窥视、对比、恢复，或从任意历史结果分出新节点。</sub></td>
    <td align="center"><sub><b>右键菜单</b>——设置类别、创建剪辑、复制、创建副本、发给 Agent、以它为参考生成、下载。</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/zh-CN/series.webp" alt="项目切换菜单：两集归在「山海少年」系列下"></td>
    <td width="50%"><img src="docs/images/zh-CN/providers.webp" alt="生成服务设置对话框，显示演示用火山方舟服务、模型 ID 和密钥已保存状态"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>系列</b>——项目切换菜单里，各集归在所属系列下。</sub></td>
    <td align="center"><sub><b>生成服务设置</b>——按类型添加服务，在应用里选区域和模型；密钥直接写入系统凭据库，之后不再显示。</sub></td>
  </tr>
</table>

## 工作原理

```mermaid
flowchart LR
  subgraph Browser["浏览器"]
    UI["网页界面<br/>画布 · 会话 · 设置"]
  end
  subgraph Host["网页宿主（127.0.0.1）"]
    WH["令牌 + Host/Origin 校验<br/>素材流式读取 · 上传"]
  end
  subgraph Daemon["studiod 本地后台"]
    GW["Gateway<br/>unix socket 上的 JSON-RPC"]
    CV["画布核心<br/>节点 · 槽位 · 修订 · 撤销"]
    WB["任务管理<br/>空间 · 会话 · Agent 运行时"]
    WK["工作项<br/>派发 · 名额 · 收件箱 · 审阅"]
    GEN["生成<br/>任务 · 重试 · 回填"]
    DB[("每个空间一个 SQLite<br/>+ 内容寻址的文件")]
  end
  subgraph Agents
    CX["Codex<br/>codex app-server"]
    DS["DeepSeek Harness<br/>dsh --profile acp"]
    CC["Claude Code"]
  end
  subgraph Providers["生成服务"]
    MK["Mock"]
    RD["本机代码渲染<br/>HTML/anime.js/three.js → 媒体"]
    CLOUD["云端服务<br/>方舟 · 可灵 · OpenAI<br/>百炼 · MiniMax · Gemini"]
  end

  UI <-- WebSocket --> WH <--> GW
  GW --> CV & WB & GEN & WK
  CV & WB & GEN & WK --> DB
  WK -- "任务说明 · 回复 · 审阅意见" --> WB
  WB -- 启动 --> CX & DS & CC
  CX & DS & CC -- "vis CLI / MCP" --> GW
  GEN --> MK & RD & CLOUD
  GEN -- "回填到槽位" --> CV
```

**完整的一圈：** 你引用几个节点、给 Agent 发消息 → Agent 用 `canvas.get` 读取它们 → 调用 `generation.submit` 并指定目标槽位 → studiod 交给生成服务执行，完成后把结果作为新修订写进该槽位 → 所有打开的窗口收到 `slot.revised` 事件，画布原地更新。

**加上工作项：** 根工作区里的任意会话调用 `work.dispatch` 建直接子工作项 → 子项 Agent 共享项目画布，用 `work.report` 报告（`question`、`blocked` 或 `done`）→ 报告发给父工作区的第一个未归档会话（按 `createdAt`、ID 升序）并进入你的收件箱，`done` 让卡片进入待审阅 → 你通过或打回。会话不再分协调者、执行者和普通对话。运行名额全局共享（默认 6 个），满了跨项目排队。回收会停下 Agent，保留工作项以便继续。只有用户能删除：停止并移除该项及子项、归档会话；工作目录和全部画布节点始终保留。本轮改动只取该工作项会话的画布事件，`changeCount` 按节点去重，`lastSeq` 记录各节点最近改动用于排序。

子项收到派发、回复或审阅反馈后结束回合却没有报告时，上级会收到通知，每个已投递批次最多一条，并附上子项最后回复的 500 个字符及尚未结束的生成任务数量。不会停止工作或移动卡片；看板提示在子项开始下一回合或报告后清除。这类通知最多唤醒上级两次，后续通知只进入你的收件箱。报告或你本人对卡片的操作（如激活、回收）会重置次数，上级自己回收再激活不会。上级可以不带 `replyTo` 回复以重启子项，也可以回收或继续等待。

会话区把连续的思考、计划和工具调用折叠成一个工作块，显示用时和工具数，展开可看完整步骤。生成结果以卡片留在工作块之外，可以预览、定位或引用。思考和计划内容取决于 Agent 适配器是否提供。

输入框工具行可按会话选择模型与思考强度，可选项来自 Agent；选择「默认」沿用 Agent 默认。切换模型时不支持的强度会恢复默认，运行中修改从下一回合生效。

当你明确指定，或你编写的技能、工作流要求时，Agent 也可以设置直接子项的模型、思考强度和速度档位（RFC 0049）：先用 `work.agentOptions` 读取准确选项，再向 `work.dispatch` 传 `agentConfig`，或用 `work.setAgentConfig` 修改已有子项的主会话，最后通过 `work.get` 确认。省略设置时使用子项 Agent 的默认值；Agent 仍不能修改自己的会话设置。

几条贯穿始终的原则：

- **唯一的能力注册表。** `packages/protocol` 声明每个方法的参数、调用方（`ui`、`agent`）和说明；命令行、MCP 服务和 `capabilities.describe` 都由它生成。
- **SQLite 是事实来源。** 每个空间一个 `space.db`，外加不可变、按内容寻址的文件。内容写入是乐观并发（`expectedRevision`），布局写入以最后一次为准。
- **昂贵的事绝不意外重复。** 生成服务超时、又无法确认对方是否已接单时，任务进入 `unknown`，不会自动重新提交。
- **严格的模块边界。** 界面包只依赖协议；画布核心与任务管理核心互不依赖，经端口协作。`pnpm check` 中的 `scripts/check-boundaries.mjs` 负责校验。

## 试用桌面预览版

适用于 **Apple 芯片 Mac** 和 **Windows 10/11 x64** 的桌面应用预览版在 [Releases](https://github.com/aliuda/visCreative/releases) 页面；项目介绍见 [everythingviscreative.com](https://everythingviscreative.com)。

- **macOS：** 下载 `.dmg`，把 visCreative 拖到“应用程序”后打开。预览版尚未公证，macOS 会拦截第一次启动：在 **系统设置 › 隐私与安全性** 里点 **仍要打开**。数据保存在 `~/Library/Application Support/visCreative`。
- **Windows：** 在 `preview-win` 版本中下载并运行 `-win-x64-setup.exe`。安装程序尚未签名，SmartScreen 会发出提示：点 **更多信息 › 仍要运行**（开启智能应用控制时，未签名应用可能被直接拦截）。只为当前用户安装，可以选择安装目录。数据保存在 `%APPDATA%\visCreative`。Windows 上没有 macOS 那样的 Agent 沙箱：Agent 以你的用户身份运行，应用自身的权限和审批规则仍然生效。

应用不需要 Node.js、pnpm 或 ffmpeg：它自己启动后台服务，并内置 LGPL 版 ffmpeg（源码随每个版本一起提供）。要用的 Agent 命令行仍需自行安装并登录；本机渲染需要 Google Chrome（Windows 上也可用 Microsoft Edge）。Intel Mac 版本稍后提供。预览版暂不自动更新：下载新的 DMG 或安装程序即可更新，数据会保留。

## 快速开始

**环境要求：** Node.js 24+、pnpm 10（通过 Corepack；Node 25 起不再自带 Corepack，需先运行 `npm install -g corepack`）、`PATH` 上有 `ffmpeg`/`ffprobe`（7 或更高版本）、Google Chrome（本机渲染与 e2e 测试需要）。要和 Agent 对话，需要已安装并登录 [Codex](https://github.com/openai/codex) 和/或 DeepSeek Harness（`dsh`）；visCreative 只负责启动它们，不打开它们的凭据文件。通过 `npx @deepseek-ai/dsh web` 安装的 DeepSeek 也能自动找到，无需全局安装；先自行运行一次完成安装和登录，visCreative 不会自动下载 dsh。

Windows 11 x64 工具链需要先安装 Python 3 和带「使用 C++ 的桌面开发」工作负载的 Visual Studio 构建工具：better-sqlite3 13.x 在本机编译。同时安装 ffmpeg，完成后重新打开终端以刷新 `PATH`：

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Gyan.FFmpeg
```

共用 lockfile 覆盖 macOS、Linux、Windows 的 x64/arm64 平台包，不代表所有架构都已支持运行。已支持 Windows 11 x64（RFC 0022）：studiod 使用命名管道，密钥存进凭据管理器，Codex 和 dsh 不经 shell 启动，Agent 使用运行时生成的 `vis.cmd`。Windows 上还需要安装 Visual Studio 构建工具（C++ 桌面开发，用于编译 better-sqlite3）、ffmpeg（`winget install Gyan.FFmpeg`），并打开开发者模式，让符号链接相关的安全测试能创建链接。本机渲染和浏览器 e2e 可通过 `VIS_CHROME_PATH` 指定浏览器；默认在 Windows 查找 Chrome 或 Edge，macOS 保留原有 Chrome 路径。

```sh
corepack enable   # Node 25+：先运行 npm install -g corepack
pnpm install
pnpm fonts:fetch   # 下载内置字幕字体（OFL），按 SHA-256 校验，不进仓库

# 终端 1：后台（数据在 ~/.vis-dev，可用 VIS_DATA_DIR 覆盖）
pnpm dev:studiod

# 终端 2：网页界面；打开输出的 http://127.0.0.1:…/#t=… 链接
pnpm dev:web
```

macOS 上 Codex 与 dsh 使用外层沙箱：允许工作区写入和联网，禁止读取生成密钥、应用令牌和数据库。各 Agent 自己的配置目录仍可读写（含自身凭据：`CODEX_HOME` 或 `~/.dsh`），但读不到其他 Agent 的（`~/.codex`、`~/.dsh`、`~/.claude`、`~/.claude.json`）。Windows 上不加隔离沙箱，允许命令和写入；只在信任的项目里使用 Agent，详见安全说明。

也可以不开浏览器，用终端客户端跑同一条链路：`pnpm dev:client`（输入 `/help` 查看命令）。

桌面外壳（RFC 0046）可从源码运行：`pnpm dev:desktop`。它会启动或连接同一数据目录的 studiod，并在自己的窗口里显示界面。依赖安装允许 Electron 下载可执行文件；Electron 45 也会在首次使用时补齐缺失的文件。

在 macOS 上运行 `pnpm --filter @vis/desktop dist:mac`，会构建临时签名（ad-hoc）的 Apple 芯片 DMG，默认写入 `artifacts/desktop/dist/`。脚本构建仓库和外壳、校验或下载字幕字体及许可证、暂存运行资源，并单独为 Electron 重编译 SQLite，不改动源码依赖。将 `VIS_PACKAGE_FFMPEG_DIR` 指向包含 LGPL `ffmpeg`、`ffprobe`、同目录 dylib、许可证及 `BUILDINFO.json` 的构建输出，运行文件会平铺复制到 `resources/ffmpeg/`；源码归档在应用外单独托管。通过 `VIS_FFMPEG_SOURCE_URL` 指定下载位置，暂存时会生成列出准确版本、许可证及归档哈希的书面源码提供说明。未设置 URL 时会警告，并以「可向分发者索取」措辞供本地预览使用；d1 发布必须要求 URL，并在源码下载中包含准确构建配方。Agent 的 PATH 会在登录 shell 的工具路径之后追加内置 ffmpeg/ffprobe 目录作为后备，因此用户自行安装的版本仍优先。此 LGPL 构建没有 libx264，请使用 h264_videotoolbox 或 libopenh264。未设置 ffmpeg 目录时构建会明确警告，媒体操作使用 `PATH` 中的 ffmpeg。

`VIS_DESKTOP_OUTPUT_DIR` 可迁移暂存文件、安装包和默认缓存（默认 `artifacts/desktop/`）；`electron_config_cache`、`ELECTRON_BUILDER_CACHE` 可分别覆盖 Electron 与打包器下载缓存。路径可用绝对路径，仓库不写入机器专有路径。`dist:mac --x64` 选择独立的 Intel 目标，尚未验证。此阶段不使用 Developer ID 或公证；正式签名和更新留待后续步骤。挂载 DMG 并复制应用后，可运行 `VIS_PACKAGED_APP="<复制目标>/visCreative.app" pnpm --filter @vis/desktop test:packaged`。测试隔离数据及项目目录，仅使用 mock 和本地生成，明确报告缺少 H.264 编码器或 Chrome 时的跳过，并在清理前关闭自己启动的 studiod。`test:smoke` 继续检查源码外壳；两种桌面验收均不计入 `pnpm check` 或网页 e2e。

在 Windows x64 主机上，`pnpm --filter @vis/desktop dist:win -- --version 0.1.0-preview-win.0` 使用同一套暂存和打包配置，在输出目录下生成 `dist/win-unpacked/` 与 `dist/visCreative-0.1.0-preview-win.0-win-x64-setup.exe`。Windows 预览版使用独立的 `0.1.0-preview-win.N` 版本序列。两个打包命令都接受 `--version <semver>`（或 `VIS_DESKTOP_VERSION`）；该覆盖只改变暂存应用和安装包，默认取 `apps/desktop/package.json`。Windows 媒体包沿用 `VIS_PACKAGE_FFMPEG_DIR` 接口，包含 `ffmpeg.exe`、`ffprobe.exe`、同目录 DLL、`LICENSES/`、声明 `win32` / `x64` 的 `BUILDINFO.json`，以及单独托管的 `source/`。打包时生成源码提供说明，`source/` 不进入应用。未签名安装器允许按用户选择安装目录；SmartScreen 可能需要点 **更多信息 › 仍要运行**，智能应用控制可能拦截未签名应用。

对 `win-unpacked` 运行 `pnpm --filter @vis/desktop test:packaged`；`VIS_DESKTOP_EXECUTABLE` 可指定其他可执行文件。严格内置媒体模式同样适用于 Windows：应用和等同 Agent 的 shell 只能使用系统工具及内置媒体回退，测试检查运行时 `vis.cmd`、本地截取和不透明渲染，最后停止隔离的 studiod 并等待其退出，以便再次打包时能替换可执行文件。

桌面及安装包图标在打包时从网站的 `favicon.svg` 生成，不维护第二份图案。macOS 应用和 DMG 使用带透明边距的 Apple 图标网格；Windows 可执行文件及 NSIS 安装器使用同一图案的 256 像素版本。

内置 `vis` 启动器支持从其他 bin 目录建立符号链接。打包时记录暂存架构并拒绝不匹配的目标；Intel 通过独立的 `dist:mac --x64` 暂存流程构建。本地截取、mock 视频和不透明渲染优先使用 x264，并提供 LGPL 编码器回退；时间线导出保持硬件优先。编码器探测失败后，下次请求会重新探测。

严格内置媒体验收可设置 `VIS_PACKAGED_REQUIRE_BUNDLED_MEDIA=1`：要求内置 ffmpeg、许可证及书面源码提供说明，不允许将源码归档装入应用，不允许 libx264，并确认测试 `PATH` 中找不到 ffmpeg。使用仅包含系统目录的 `PATH`，并设 `SHELL=/usr/bin/false` 阻止导入登录 shell 的 PATH，通过 Node 的绝对路径启动测试。arm64 的 LGPL ffmpeg 9.0.2 已通过此验收，mock 视频和本地渲染均选择 VideoToolbox。

可用 `pnpm build:ffmpeg:mac --arch arm64` 从锁定版本的源码构建 macOS LGPL 媒体工具包（Intel 使用 `--arch x64`）；构建工具、输出与缓存设置、许可证及验证方法见 [RFC 0046 步骤 c2](docs/rfc/0046-desktop-app.md#as-built-step-c2-2026-11-13)。 Windows x64 uses the same ten pinned components plus MIT NVENC/AMF headers, the oneVPL dispatcher and Zlib-licensed zlib for required PNG/APNG support, built by `node scripts/build-ffmpeg-windows.mjs` on Ubuntu 24.04 with mingw-w64/MSVCRT. The Windows FFmpeg workflow builds and verifies the DLL bundle on Windows, then produces a runtime ZIP, a separate exact-source TAR and SHA256SUMS without publishing; it supports manual dispatch and archive trial pushes to `ffmpeg-build/**`. Run `node scripts/ffmpeg/verify-windows.mjs <out>/win32-x64` for licence, import-closure, media and relocation checks; the Media Foundation trial is skipped when unavailable. The cross-build still needs its first Actions acceptance; see [Windows FFmpeg](docs/rfc/0046-desktop-app.md#as-built-windows-ffmpeg-2026-11-13).

### 本机渲染与自备库

本机渲染内置 MIT 许可证的 anime.js 4.5.0（`/lib/anime.js`），以及 rough.js 和 three.js。也可直接使用 JavaScript。页面离线运行，通过 `window.vis.seek(t)` 接收秒数；anime.js 时间轴须暂停，并将 `t` 换算为毫秒。

如需其他库，请自行创建 `<dataDir>/render-libs/`（开发环境为 `~/.vis-dev/render-libs/`），将浏览器 JavaScript 文件直接放入其中。文件名须匹配 `^[A-Za-z0-9._-]+\.js$`，例如 `helper.js` 对应 `/lib/helper.js`。不接受子目录或指向该文件夹外的符号链接。内置的 `anime.js`、`rough.js` 以及所有 `three*` 名称保留给产品。渲染时重新读取文件，新增或替换后无需重启后台服务。请将应用数据目录放在项目和 Agent 工作目录之外。

visCreative 不内置、不依赖、不下载、不安装 GSAP。GSAP 由 Webflow 单独许可；作者须自行阅读并接受其许可证，再将自备的 `gsap.js` 放入 `render-libs`。已有 HTML 若加载 `/lib/gsap.js`，在提供文件前会以本地化的 `render.lib_missing` 原因失败。只有作者明确说明库已可用，Agent 才可使用，且不得自行安装或写入 `render-libs`。网关权限以及命令、文件审批规则继续生效。

### 接入真实生成服务

1. 点右上角的 ⚙︎（或按 <kbd>⌘</kbd> <kbd>,</kbd>）。
2. 在**生成服务**里点 **+ 添加服务**，选择服务类型：**火山方舟**、**可灵**、**OpenAI 图片**、**阿里云百炼（万相）**、**MiniMax** 或 **Gemini**（除方舟和 MiniMax 外都标为未经真实接口验证）。区域保持预选即可；如果使用自己的网关或专属地址，选择**自定义地址**（需兼容该服务的接口，密钥会发送到该主机）。使用自定义地址时，在**接口路径**里填写各操作的路径，留空时直接请求 Base URL；请求和响应格式仍需与所选服务一致。然后添加模型：已知模型一键添加，也可以填自定义模型 ID（方舟填控制台里的模型 ID 或推理接入点 ID）。默认模型和每日上限在**默认模型与额度**里。
3. 粘贴 API Key，点 **保存密钥**。密钥写入 macOS 钥匙串或 Windows 凭据管理器（服务名/resource 为 `vis-creative.provider`），输入框随即清空。
4. 选好默认模型，新建一个生图节点，写下提示词，点生成。每个节点都可以在提示词面板里单独切换模型和参数。

音频上传接受 MP3、WAV、M4A、AAC、OGG、FLAC；只有音轨的 MP4/WebM 也会识别为音频。音频节点显示波形、播放控件和时长，同一时刻只播放一个节点。设置里可填写音频模型并选择默认值；未配置默认值时使用 **Mock 音乐**（`mock-music-1`），也可选 **Mock 音效**（`mock-sfx-1`）。视频生成可以引用音频节点；方舟不支持的音频参考会在本地拒绝。真实 Seed-Audio 生成待取得官方接口文档和邀测资格后接入，仅填写音频模型 ID 不会启用适配器。本期不做 TTS。

Seedance 2.0 和 Seedance 2.5（`doubao-seedance-2-5-260628`）支持视频参考。在**生成服务 → 媒体托管**中配置自己的火山引擎 TOS 存储桶，并把密钥保存到系统凭据库。参考片段会离开本机上传到该桶；签名链接到期前，持有链接的任何人都能读取它。建议给配置的前缀添加 3 天后删除对象的存储桶生命周期规则。在视频节点的提示词面板中选择支持的模型并添加画布视频参考，就能提前查看封面、每段时长、数量和总时长限制；仅在所选模型需要托管且尚未配置时显示设置入口；Mock 等本地模型无需托管即可使用。参考编号按图片、视频、音频分别计数，提交时将节点引用标记转换为所选 Seedance 模型对应的引用名称。限制以所选模型为准。如果这里无法读取时长元数据，面板会说明仍可提交，由服务端校验片段。视频参考时长会增加计费 token；参考素材不能与首帧或首尾帧模式混用，方舟会拒绝包含真人面孔的上传参考图片或视频。唯一一次付费验收仍待维护者批准（RFC 0043 §9）。

生成面板和剧本提示词中的 `@` 可搜索已连接的参考素材，以及「画布上」分组里兼容的未连接素材（包括隐藏的工作节点）。选择画布素材会先连接，再插入编号标签；删除标签不会断开连接。画布结果按层级从上到下最多显示 50 个匹配项，超出时提示缩小搜索范围，达到模型参考数量上限时禁用相应候选项。

**剪辑**在剪辑节点里完成（RFC 0024）。把选中的镜头建成剪辑，或在分镜表上点「组装成剪辑」，再从卡片打开（「打开剪辑」或双击）。
- **轨道**：1 条视频轨，最多 4 条音频轨放配乐、音效和配音；每轨最多 200 个片段，总长最多 30 分钟。
- **片段**：移动、裁剪、波纹、切分、复制、吸附，调音量和淡入淡出。
- **变速**：0.25–4×，保持音调。
- **转场**：任意切点可加交叉淡化或闪黑；转场让前后片段重叠，成片相应变短。
- **叠加**：最多 2 条叠加轨，画在视频之上、文字之下，用于 Logo、贴纸和画中画视频。每个片段按中心位置、宽度和透明度摆放，可在检查器里调（六个摆放预设），也可在预览画面里直接拖动、缩放；淡入淡出作用于画面（视频还包括声音）。预览同时只播放一路叠加视频，超出时显示「预览受限」，导出包含全部叠加。
- **文字**：最多 2 条文字轨，有字幕、综艺花字、电影字幕、标题四种预设。可用四款内置字体（思源黑体、得意黑、霞鹜文楷、站酷快乐体），也可上传自己的 TTF/OTF，上传字体的授权由用户自己负责。「字幕联动」默认打开，字幕跟着所在的视频片段移动和删除。
- **预览**：浏览器预览按导出用的字体和时间显示变速、转场和文字，像素上可能略有差异，以导出为准。
- **导出**：用 ffmpeg 导出为普通视频或音频节点；只有文字时用黑底导出。

Agent（Codex、DeepSeek、Claude Code）可以建立、修改同样的剪辑（包括叠加）并导出。

设置 › 护栏中的 **Agent 每日图片 / 视频 / 音频上限**默认分别为 50 / 10 / 20。只限制 Agent 提交的付费生成；你在界面上的生成不受限制，也不占额度。额度跨项目共用，按本地日期统计，`0` 表示不限。最大并发仍对所有付费任务生效；Mock 与 render 不计数。顶栏显示今日全部付费提交数，包括失败和取消的任务；用量详情另列 Agent 已用 / 上限。

<details>
<summary><b>环境变量</b></summary>

| 变量 | 作用 |
| --- | --- |
| `VIS_DATA_DIR` | 空间、文件和 `providers.json` 的存放位置（开发默认 `~/.vis-dev`）。 |
| `VIS_WEB_PORT` | 固定网页宿主端口（默认随机）。 |
| `VIS_CODEX_PATH`、`VIS_CODEX_MODEL` | 指定 Codex 可执行文件 / 模型。 |
| `VIS_DSH_PATH`、`VIS_DSH_MODEL` | 指定 DeepSeek Harness 可执行文件 / 模型。依次查找显式路径 → `PATH` → `~/.npm/_npx` 中已安装的最高版本；显式路径无效时直接报错，不切换版本。 |
| `DEEPSEEK_API_KEY` | 可选的 dsh 凭据，只原样透传，不记录或保存；也支持 `~/.dsh` 中的账号登录。 |

</details>

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 平移与缩放 | <kbd>拖动空白处 / 双指滑动；捏合 / ⌘ 滚轮</kbd> |
| 框选节点 | <kbd>Shift 拖动</kbd> |
| 撤销 / 重做画布操作 | <kbd>⌘ Z / ⌘ ⇧ Z / Ctrl Y</kbd> |
| 复制 / 粘贴 / 创建副本 | <kbd>⌘ C / ⌘ V / ⌘ D</kbd> |
| 删除选中 | <kbd>Delete / Backspace</kbd> |
| 移动聚焦节点 / 加速移动 | <kbd>← ↑ → ↓ / Shift ← ↑ → ↓</kbd> |
| 越界移出框 | <kbd>⌘ 拖动</kbd> |
| 全屏预览图片 / 视频 | <kbd>Space</kbd> |
| 切换版本 / 设为当前 / 退出版本选择 | <kbd>[ / ] / Enter / Esc</kbd> |
| 保存文本或提示词 / 取消编辑 | <kbd>⌘ Enter / Esc</kbd> |
| 预览上一个 / 下一个节点 | <kbd>← / →</kbd> |
| 预览适应窗口 / 原始大小 / 放大 / 缩小 | <kbd>0 / 1 / + / -</kbd> |
| 播放 / 暂停选中音频或预览视频 | <kbd>Space</kbd> |
| 预览视频后退 / 前进 5 秒 | <kbd>J / L</kbd> |
| 预览视频后退 / 前进一帧 | <kbd>, / .</kbd> |
| 预览视频静音 / 取消静音 | <kbd>M</kbd> |
| 收起 / 展开会话面板 | <kbd>⌘ \</kbd> |
| 发送消息 / 换行 | <kbd>Enter / Shift Enter</kbd> |
| 在画布和看板之间切换 | <kbd>⌘ ⇧ B</kbd> |
| 设置 | <kbd>⌘ ,</kbd> |
| 打开快捷键介绍 | <kbd>?</kbd> |
| 关闭快捷键介绍或媒体预览 | <kbd>Esc</kbd> |

在输入框里打字时，快捷键交给浏览器处理。Windows/Linux 上用 <kbd>Ctrl</kbd> 代替 <kbd>⌘</kbd>。

## 目录结构

```
apps/
  web/                 本机网页界面（React + React Flow）及其宿主进程
  cli/                 `vis`：Agent 调用的薄客户端，同时提供 MCP 服务
  devcli/              开发用终端客户端
  desktop/             Electron 外壳与 macOS DMG 打包
services/
  studiod/             本地后台：Gateway、模块组装、生成服务与密钥管理、
                       工作项、全局运行名额、父子关系权限
packages/
  protocol/            RPC / 事件 / 错误码 schema，唯一契约
  domain/              核心对象、纯规则、跨系统端口
  storage/             SQLite schema（Drizzle）、迁移、事件日志
  assets/              素材导入、版本、媒体探测、受控读取
  generation/          任务、执行器、回填；生成服务：mock、render、方舟、可灵、
                       OpenAI、百炼、MiniMax、Gemini
  canvas/core | ui     画布模型与画布视图
  workbench/core | ui  空间、会话、Agent 运行时；会话面板、
                       工作区树、看板、收件箱、审阅抽屉
  library/core | ui    资产库：标注、整理、设定、系列；资产库面板
  previz/ui            镜头预演：全屏画格编辑器
  writing/ui           长文写作页
  timeline/ui          全屏剪辑器
  workbench/codex | deepseek | claude   Agent 适配器
  ui-kit/              共享主题与基础组件
docs/rfc/              设计文档
```

**依赖规则**（`pnpm check` 校验）：`*-ui` 只依赖 `protocol` 与 `ui-kit`；`canvas-core` 与 `workbench-core` 互不依赖；`generation` 经 `domain` 端口回填，不引入画布；`cli` 只依赖 `protocol`。新增包需先在 `scripts/check-boundaries.mjs` 登记。

## 开发

贡献前，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 中的安装、验证命令和 RFC 流程，以及 [AGENTS.md](AGENTS.md) 中的仓库规则。集成开发另有[新增 Agent 指南](docs/contributing/adding-an-agent.md)和[新增生成服务指南](docs/contributing/adding-a-provider.md)（英文）。

```sh
pnpm check                         # 依赖边界 + 类型检查 + 单元测试
pnpm build                         # 构建 CLI、后台、开发客户端和网页界面
pnpm --filter @vis/web test:e2e    # 浏览器端到端测试（需先构建，需要 Chrome）
pnpm --filter @vis/web perf        # 剪辑性能报告，写到 /tmp/vis-perf（需先构建，需要 Chrome）
pnpm --filter @vis/web readme-shots  # 中英文 README 截图（需先构建，需要 Chrome、ffmpeg 和中文字体）
```

`readme-shots` 会启动一个隔离的守护进程，只用 Mock 和本机渲染服务以及脚本化的假 Codex，搭好示例制作后写出 `<tmpdir>/vis-readme-shots/{en,zh-CN}/*.png`（可用 `VIS_SHOTS_OUT` 改路径），不调用付费接口，也不启动真实 Agent。README 选用其中一部分，转成 WebP 放在 `docs/images/en` 和 `docs/images/zh-CN`；详见 `apps/web/readme-shots/CAPTURE.md`。

端到端测试会启动真实的后台和网页宿主，配合脚本化的假 Agent 与本地假生成服务器运行；不调用任何付费接口；macOS 沙箱回归只创建测试专用服务的假钥匙串条目并在 finally 删除，不读取生产 Key。

[GitHub Actions CI](.github/workflows/ci.yml) 使用 Node 24，每个 PR 和推送到 `main` 都在 Linux 上执行检查、构建和一轮完整浏览器 e2e。推送到 `main` 时还会在 Windows 和 macOS 检查和构建。手动触发支持 `os=all|ubuntu|windows|macos`（默认 `all`），只有选择 Ubuntu 时才包含 Linux e2e。公开仓库使用免费 runner；归档仓库的工作流已停用，不再使用。CI 下载字幕字体、配置 ffmpeg、报告 ASS 滤镜缺失导致的跳过，并上传失败日志和截图，不需要服务商密钥或真实 Agent。Linux 没有隔离沙箱，所以原生命令审批用例由共用的平台判断明确跳过；注册表和附件测试仍会运行。CI 使用一个浏览器测试进程，默认每个测试限时 40 秒；本地仍为 20 秒，各断言的等待时间不变。临时 Fontconfig 配置让浏览器使用已下载的中文字体。这不代表产品已完整支持 Linux；平台覆盖和预期跳过项见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全模型

- 网页宿主只监听 `127.0.0.1`，每次启动生成令牌；校验 `Host`（防 DNS 重绑定）与 `Origin`（防跨站请求）。
- Agent 用每个实例独立的令牌认证，只能调用 `callers` 包含 `agent` 的方法；密钥管理只对界面开放。
- Windows 遇到短暂的文件替换失败时，Ark 提交记录始终保留幂等占位。只重试文件 rename，绝不重复付费 HTTP 提交。
- 工作项权限由 Gateway 按调用方与工作区关系检查：只有根工作区能派发，Agent 只能管理直接子项，只有子项能向父项报告。未关联工作项的会话不能调用工作项写方法。共享画布写入靠修订号校验，画框不授予权限。
- 生成服务的 API Key 只存在系统凭据库：macOS 钥匙串或 Windows 凭据管理器（`PasswordVault`，resource 为 `vis-creative.provider`，userName 为供应商 ID）。Windows 的 PowerShell 脚本与密钥都通过 stdin 传入，错误流直接丢弃。密钥不进入数据库、配置文件、日志、事件、错误信息或 Agent 工具返回值，也不会出现在子进程的命令行参数里。
- Windows 上 Agent 以当前用户身份运行，没有隔离沙箱，技术上能读取已保存的凭据、studiod 令牌和数据库。只在信任的项目里使用 Agent。Gateway 权限、环境变量过滤与命令/文件审批仍然生效；`providers.list` 在 Windows 和 Linux 返回 `agentIsolation: 'none'`，macOS 返回 `'sandbox'`。
- macOS Codex 的整个进程树由 Seatbelt 隔离：允许工作区读写、命令和联网，禁止钥匙串服务与 studiod 私有数据读取；仅继承白名单环境。所有会话（包括未关联工作项的会话）的 vis 工具确认一律自动通过；其他命令和文件审批支持单次允许、会话内相同操作复用和拒绝，10 分钟或停止后过期；审批不会放开外层禁止的写入。
- CODEX_HOME 是明确例外：整个目录可读写，包含 Codex 自身凭据。缺少 sandbox-exec 或公共 PEM 根证书时退回只读并提示；dsh 继续只读，其 OS 密钥隔离尚待实测。详见 RFC 0005。
- 对作者内容的保护由网关强制执行，不靠提示词：Agent 不能覆盖或删除你最后编辑的文字，不能修改画格图片，不能写入你的 Skill 库，也不能删除工作项。它们只能发起删除申请，由一次性的批准卡片决定。
- Agent 的输出按 Markdown 渲染且不允许原始 HTML；Agent 写的任何内容都不会在页面里执行。
- Agent 保留自带的能力，包括网页搜索与读取（RFC 0048）。Codex 使用实时网页搜索，它打开的页面由 OpenAI 的服务器抓取；搜索记录显示在会话里。自动审批下，Agent 自带的只读网页搜索与读取和工作目录内的命令一样直接放行；其他联网请求仍然询问。
- Windows 上 Agent 以当前用户身份运行，没有隔离沙箱，也不退回只读；理论上能读取本机保存的 API Key、应用令牌与数据库。只在信任的项目里使用 Agent。服务端返回 `agentIsolation: 'none'` 时，设置的密钥输入框上方与「安全与额度」中常驻提醒。Codex/dsh 仍使用环境白名单，Gateway 权限和工具审批仍生效；自动审批先解析 junction 再处理 `..`，比较路径时忽略大小写，无法解析的链接保持询问。

## 设计文档

| RFC | 主题 |
| --- | --- |
| [0001](docs/rfc/0001-multi-agent-creative-space.md) | 多 Agent 创作空间：整体设计 |
| [0002](docs/rfc/0002-sqlite-storage.md) | 以 SQLite 为事实来源 |
| [0003](docs/rfc/0003-core-contracts.md) | 核心契约：身份、修订、生成输入、撤销、历史 |
| [0004](docs/rfc/0004-runtime-and-agent-entry.md) | 运行时与 Agent 入口 |
| [0005](docs/rfc/0005-agent-adapters-and-mcp.md) | Agent 适配器与 MCP |
| [0006](docs/rfc/0006-web-ui.md) | 网页界面 |
| [0007](docs/rfc/0007-generation-providers.md) | 生成服务、火山方舟与密钥存储 |
| [0008](docs/rfc/0008-projects-and-workspaces.md) | 项目、工作区与项目技能 |
| [0009](docs/rfc/0009-work-items-and-board.md) | 工作项、多 Agent 派发与看板（[界面规格](docs/rfc/0009-ui-spec.md)） |
| [0010](docs/rfc/0010-workspaces-without-canvas-binding.md) | 项目共享画布、无角色会话与简化会话面板 |
| [0011](docs/rfc/0011-project-delete.md) | 删除项目、最近删除、恢复与永久删除 |
| [0012](docs/rfc/0012-audio-assets-and-generation.md) | 音频素材、Mock 音乐与音效，以及只约束 Agent 的每日生成上限 |
| [0013](docs/rfc/0013-agent-activity.md) | 会话区显示 Agent 活动：思考、状态行、计划与工具中文名 |
| [0014](docs/rfc/0014-session-model-and-effort.md) | 会话级模型、思考强度与速度（如 Codex Fast） |
| [0015](docs/rfc/0015-session-experience.md) | 会话体验：附件、自动审批、轻分隔排版、上划加载、拖到看板、挪子项、恢复队列 |
| [0016](docs/rfc/0016-canvas-organization.md) | 画布整理：类别、服务端摆放、框收住节点、整理、代码渲染、工作文档、快捷键 |
| [0017](docs/rfc/0017-skill-import.md) | 导入与管理项目 Skill：从文件夹、压缩包或其他项目导入，暂存确认，替换与可找回的移除 |
| [0018](docs/rfc/0018-i18n.md) | 界面中英切换：默认跟随浏览器，设置里切换，后台错误与 Skill 问题按原因码本地化，检查写死的文案 |
| [0019](docs/rfc/0019-ui-polish-batch1.md) | 界面打磨第一批：靛蓝主色、顶栏和画布降噪、文本节点渲染 Markdown、会话输入区重做 |
| [0020](docs/rfc/0020-ui-polish-batch2.md) | 界面打磨第二批：统一对话框与浮层、SVG 图标、设置分组导航、卡片减框、媒体节点按素材比例 |
| [0033](docs/rfc/0033-author-skill-library.md) | 作者 Skill 库：Agent 按请求起草，作者在设置中编辑、保存或丢弃，以固定副本用于项目，支持更新/发布/重置、新项目默认使用、Markdown 草稿和实时会话卡 |
| [0034](docs/rfc/0034-agent-requested-work-cleanup.md) | Agent 请求清理直接子工作项，作者单次授权、影响绑定并保留画布 |
| [0035](docs/rfc/0035-silent-turn-watchdog.md) | 静默回合：提示并通知上级，但不自动停止；Agent 无响应时停止也一定能完成 |
| [0036](docs/rfc/0036-transparent-render.md) | 本机透明视频：WebM 渲染、预览与时间线叠加，以及 ProRes 4444 MOV 本地交付 |
| [0037](docs/rfc/0037-interactive-scene-nodes.md) | 可交互 3D 场景节点：带多个命名机位的舞台，可摆姿势的人偶、道具和导入的 `.glb` 模型；独立于镜头预演，可把视角输出为图片或发送到画格 |
| [0038](docs/rfc/0038-unreported-child-turns.md) | 子项未报告便结束回合：持久通知上级并在看板提示，在报告或作者操作前最多唤醒上级两次 |

RFC 0010 升级保留历史事件与请求记录：旧游标重取当前快照，不可重放的旧请求返回 `request_not_replayable` 且不再执行；工作区 `lastChangeSeq` 使同节点再次修改也推进修订号。

## 路线图

- [x] RFC 0014 会话级模型与思考强度选择，下一回合生效；支持 Codex 的 Fast 等速度档位
- [x] RFC 0013 会话活动界面：运行计时、思考摘要、计划进度与工具中文名
- [x] 共享画布：节点、槽位、修订；来源与参考连线；小地图
- [x] Codex 与 DeepSeek Harness 会话：流式回复、引用节点
- [x] 手动生图/生视频节点：浮动提示词面板、⊕ 快速延伸
- [x] 撤销/重做、右键菜单、复制/粘贴/创建副本、下载
- [x] 版本历史：窥视、恢复、另存为节点
- [x] 火山方舟接入：应用内配置、钥匙串存储密钥
- [x] MIT anime.js 支持确定性的本机渲染，可选用作者自备的 `render-libs`；内置库名受保护，缺失库错误支持中英文；GSAP 单独许可，不随产品分发
- [x] 全屏预览：缩放查看、自定义视频播放器、预览内版本对比
- [x] 分镜：由 RFC 0023 脚本节点取代（一个节点装整张镜头表）
- [x] 取消与重新生成；费用护栏
- [x] 节点级生成设置入库
- [x] 工作项与多 Agent 协作：派发、看板、收件箱、审阅、用户级联删除
- [x] RFC 0010：移除画框绑定和角色、按父子关系授权、按事件记录改动、简化会话面板与看板
- [x] RFC 0011：项目移入最近删除、恢复，以及带目录安全检查的永久删除
- [x] RFC 0012 第一期：音频上传与播放节点、Mock 音乐与音效、音频参考输入、只约束 Agent 的每日上限
- [ ] RFC 0012 第二期：取得官方接口文档和邀测资格后接入 Seed-Audio 服务
- [x] 体验优化第一批：画布滚轮与节点不再冲突、选中时高亮相关连线、视频节点尺寸统一、新建按钮精简、Agent 图标、看板列等高与子项折叠
- [x] 体验优化第二批：新建项目时同时建好第一个工作区
- [x] RFC 0015 会话体验：画布外素材作附件、只放行目录内命令与写入的自动审批、轻分隔排版、上划加载历史、拖到看板状态、挪为子项、暂停队列的继续与清空
- [x] RFC 0016 画布整理：类别与用途、服务端摆放不重叠、框收住节点并自动撑大、按类别整理、代码节点手动渲染、工作文档默认隐藏、空画布快捷键；Agent 不能创建工作文档用途的媒体或将媒体成品改为工作文档，作者仍可自行设置；已有工作媒体的元数据更新与成功请求的重试保持可用
- [x] RFC 0017 Skill 导入：从文件夹、`.zip` / `.skill` 压缩包或其他项目导入项目 Skill；暂存后确认并提示脚本，勾选才替换，移除可找回，列出无法识别的目录
- [x] RFC 0018 界面中英切换：默认跟随浏览器语言，在「设置 › 通用」切换（换浏览器也保留），后台错误与 Skill 问题按原因码本地化并保留英文兜底，失败通知保留结构化原因，旧结果诊断显式映射为界面文案，`pnpm check:i18n` 拦截写死的中文界面文案
- [x] RFC 0019 界面打磨第一批：主按钮和选中统一用靛蓝主色，项目名只出现一次，隐藏调试信息，画布文本节点渲染 Markdown，会话输入区改成一张卡片配圆形发送 / 停止按钮，Agent 回复带名称，空会话有引导
- [x] RFC 0020 界面打磨第二批：对话框统一遮罩和关闭按钮，收件箱、今日用量等浮层不压暗页面；文字箭头和关闭符号换成 SVG 图标；设置改为分组导航；会话列表和看板卡片只留一层框；写入图片或视频时由后端把节点高度调整到素材比例
- [x] RFC 0022 Windows 支持：共用平台 lockfile、跨平台构建与测试工具、studiod 命名管道、Windows 凭据管理器、不经 shell 启动 Codex / dsh、识别 junction 的自动审批边界、选目录与在资源管理器中显示、Chrome / Edge 查找，以及事先提醒 Windows 上 Agent 没有隔离沙箱 后续修复已统一 Skill ZIP 限额、为副本原子替换增加有界重试、等待 Claude/Codex 进程真正退出，并限制长文大纲 DOM；macOS 回归已覆盖，Windows 仍须按[已知问题](docs/known-issues.md)复测。 渲染取消会先等待编码器与 Chrome 关闭，再清理部分输出；Windows 短暂文件锁采用有界重试，清理失败也不会阻塞后续渲染。
- [x] RFC 0021 节点组件（第四期 a）：图片、视频、音频节点的顶部工具条由操作目录驱动；不依赖服务商的 ffmpeg 本地处理以幂等后台任务执行并可撤销（裁剪、宫格切分、截取、抽帧、分离音频、自定义与智能切分、变速）；生成类操作只在服务商模型声明时出现；可编辑节点标题；视频控件收为一行、音频波形可拖动定位；输入面板支持带编号的参考引用。审查修复统一仅含素材的媒体引用编号，停止会话或回收时取消媒体任务，按发起轮次校验写回，瞬时推送进度，并兼容图片方向与微小时长差异。生成面板和剧本提示词中的 `@` 可搜索已连接的参考素材，以及「画布上」分组里兼容的未连接素材（包括隐藏的工作节点）。选择画布素材会先连接，再插入编号标签；删除标签不会断开连接。画布结果按层级从上到下最多显示 50 个匹配项，超出时提示缩小搜索范围，达到模型参考数量上限时禁用相应候选项。
- [x] RFC 0023 脚本节点第一步（4b-1）：脚本节点装一张可编辑的分镜表（按行冲突、撤销、导出）；人物、场景、道具作为共享资产并可挂参考图；由负责会话拆解剧本、撰写首帧 / 尾帧 / 视频提示词（标记过期与手改）；从镜头建单个生成节点
- [x] RFC 0023 第二步（4b-2）：镜头之间的首尾帧衔接（连续镜头参考上一镜的帧图，可选严格模式抽取上一镜视频的最后一帧）；按分镜批量生成帧图和视频，由服务端执行，重启续跑、不重复提交、额度用完时暂停；用户发起需确认，Agent 发起需审批后才执行
- [x] RFC 0026 Agent 说明：Codex 和 DeepSeek 共用一份简短的英文说明（346 词，Codex 常驻说明缩小 66%），让 Agent 放手使用自己的能力，并讲清费用和并发修改的规则及原因；分镜、剪辑、代码渲染、本地媒体、生成和画布节点的细则改成按需阅读的专项说明（`guide` 工具、`vis guide [主题]`），分镜或剪辑写错时报错会指向对应说明；Agent 看到的工具说明改为英文；DeepSeek 在隔离沙箱内开放子 Agent、工作流和后台任务；Agent 不再能读取 Claude Code 的凭据；新增可选的真实 Agent 评测（`pnpm --filter @vis/web agent-eval`，只用 Mock 和代码渲染）对比改动前后的表现
- [x] RFC 0025 性能修复第一版：1000 个节点的画布一秒内打开、平移约 70 FPS（保留 React Flow 测量结果、节点按需选择状态、Markdown 只解析一次、缩小时显示纯文本、历史按槽位订阅）；studiod 空闲时每分钟约 0.2 秒 CPU，原来约 3 秒（每次轮询先做便宜检查、推送出错有隔离和退避、批量生成只在待审批或运行中时轮询；因额度暂停的批次只在点继续时唤醒）。首次尺寸回调返回前也保留测量记录，避免生成更新清掉连线端点缓存、导致来源连线消失。
- [x] 界面打磨（2026-11-05）：缓存 ffmpeg 版本检查，7 以下版本导出时显示中英文原因；画布工具条避开固定控件；分镜设定勾选、参考图操作、单一负责会话行与素材库/生成服务设置更清晰。RFC 0009 界面、0015、0024 状态区分已实现内容与待补的真机和真实 Agent 验收。
- [x] RFC 0024 剪辑节点 a 步：剪辑节点带 1 条视频轨和最多 4 条音频轨，可新建空剪辑，也可以把选中的镜头按阅读顺序建成剪辑；Agent 通过整份文档写入（服务端校验）排粗剪：拼接镜头、加配乐并裁剪、淡入淡出；用 ffmpeg 导出为普通视频 / 音频节点（能直接拼接就不重编码，自动检测硬件 H.264 编码器），导出固定提交时的版本并用 exportOf 连回剪辑；画布卡片显示最新导出、迷你时间线和「未导出的修改」标记
- [x] RFC 0024 剪辑节点 b 步：从剪辑卡片打开全屏编辑器（「打开剪辑」或双击），包含素材库、预览播放器（两个视频元素交替，用 AudioContext 时钟和 Web Audio 做淡入淡出与轨道音量）、检查器和时间线：移动、裁剪、波纹、切分、复制、吸附、缩放、多选和快捷键；修改在后台带版本号保存，支持本次编辑的撤销，Agent 改了文档时显示冲突横幅；波形和缩略图条由服务端生成，按项目缓存，与本地媒体任务共用槽位
- [x] RFC 0024 c 步（第一部分）：脚本节点「组装成剪辑」（每个镜头取最新视频，没有就用首帧图片按计划时长显示）；画布音频波形改用服务端缓存的峰值，浏览器不再解码；视频版本记录源帧率，用于时间码和逐帧步进；冲突横幅显示写入的会话
- [x] RFC 0024 c 步（第二部分）：预览单独排一个槽位的队列，长导出不再拖慢波形和缩略图条；新增对照 RFC §8 指标的性能测量脚本（`pnpm --filter @vis/web perf`，已在 macOS 实测）；片段切换不再黑帧，编辑器暂停时不再逐帧占用主线程，画布上无关节点的改动不再让编辑器重渲染；用 LGPL ffmpeg 构建验证导出（VideoToolbox，回退 libopenh264）；浏览器 e2e 在 macOS 上通过
- [x] 稳定性与内存：画布视频节点平时显示缓存的封面帧（`media.preview` 新增 `poster`），只在悬停、聚焦、选中或播放时才挂载播放器，30 个闲置视频节点占用的页面内存从约 430 MB 降到约 67 MB（`apps/web/perf/memory.perf.ts` 用 macOS `footprint` 按阶段测量）；不稳定的浏览器 e2e 用例改为等界面更新后再断言
- [x] RFC 0024 Windows 实测与真实 Codex 试用：Windows 参考机上 §8 各项指标达标，只有播放后的渲染进程内存（私有约 490–540 MiB，关闭编辑器只释放一部分）例外；真实 Codex 会话在五个场景里建剪辑、改剪辑、导出都没有出错，Agent 说明补充了剪辑还不支持哪些效果
- [x] RFC 0024 d 步：片段变速（0.25–4×，保持音调），交叉淡化和闪黑转场，预览与导出时长一致；最多两条文字轨，通过 ASS 烧进画面，四种预设，四款内置 OFL 字体（`pnpm fonts:fetch`）或上传的 TTF/OTF 字体，只有文字时黑底导出，Agent 可用 `font.list`；编辑器新增速度预设、切点转场按钮（重叠处显示斜纹）、文字轨和文字检查器，以及让字幕随视频片段移动和删除的「字幕联动」开关
- [x] RFC 0024 e 步（第一部分）：图片叠加轨，用于 Logo 和贴纸。最多两条叠加轨，画在视频之上、文字之下；每个片段按中心位置、宽度和透明度摆放，可以淡入淡出画面；从素材栏拖入，在检查器里调（六个摆放预设）或在预览画面里直接拖动、缩放并吸附；导出时保留透明通道合成。内存排查确认播放后的内存不会随反复开关累积（是浏览器底层的固定占用），画布标题读取视频信息后会立即释放媒体元素（10 个视频节点约省 31 MiB）
- [x] RFC 0024 e 步（第二部分）：视频画中画。叠加轨也可以放视频，支持裁剪、变速、音量、淡入淡出和整轨静音；预览播放最上层的一路叠加视频，其余停在当前帧并显示「预览受限」，导出包含全部叠加视频及其声音
- [ ] RFC 0024 后续：在真实的最低配置机器上实测，验证 Windows 上的 LGPL ffmpeg 构建；d 步和 e 步的 Claude Code 真实验收（Codex 和 DeepSeek 均已通过）；单素材音频操作（D3）；在低配机器上实测后再放宽预览只播放一路叠加视频的限制
- [x] RFC 0027 资产库：资产库面板：用户发起后由项目的资产库会话为素材起名、分类、打标签（手改的字段始终优先），并建议把同一主体的素材归并成设定、由用户确认；项目级设定（人物、场景、道具和风格从脚本节点提升到项目，参考图固定到素材版本；`generation.submit` 可直接用素材版本作输入，从脚本生成时自动带上人物和风格参考图）；系列：项目可以作为系列的一集（在项目切换器里按系列分组），系列共享的设定存在系列自己的资产库里；每集引用固定在某个系列版本的副本，系列有新版本或本集改过时会标出，更新、发布和还原都由用户手动发起；智能体可以列出系列设定并直接引用，而不是重新创建，但不能发布
- [ ] RFC 0028 Agent 与生成服务注册（a–d 四步已完成，真实接口验收未完成）：Agent 通过描述注册（ID、名称、图标路径、安装提示、额外环境变量名、沙箱对其他 Agent 一律屏蔽的凭据路径），新增一个 Agent 只需一个适配器包加一处注册，不用改协议、存储或界面里的列表；新建工作区现在可以选 Claude Code；已移除 Agent 的会话仍可阅读但不能运行，看板照样能移动它们的卡片。生成服务按类型描述注册（区域、已知模型、帮助、专属字段、是否已验证），保存、加载和恢复任务时都按类型校验；设置页改为通用的「生成服务」页面，先选类型再填表；所有付费适配器都要通过同一套契约测试（不重复提交、响应丢失记为结果未知、服务确认后才算取消、下载有上限、审核原因透传、错误和日志里不出现密钥），同步接口有落盘辅助。已接入可灵（视频 3.0、3.0 Omni、4.0，图片 3.0 Omni；提交响应丢失时按自有任务 ID 找回）和 OpenAI 图片（GPT Image 2 与 2.5；同步接口，结果先落盘），同时接入了阿里万相（百炼，支持 wan2.7 与 wan3.0 视频；预设北京和新加坡，其他地区和 wan3.0 通过自定义地址填写工作空间域名）、MiniMax（H3 视频和 `image-01`；不支持取消，因为服务商的 DELETE 可能删掉已完成的任务）和 Gemini（Nano Banana 图片、Omni Flash 视频）。MiniMax 已于 2026-11-08 通过真实接口验收（中国区，H3 视频和 `image-01`），其余四个在验收前仍标为未验证。贡献者可阅读[新增 Agent](docs/contributing/adding-an-agent.md)和[新增生成服务](docs/contributing/adding-a-provider.md)指南。下一步：用维护者的密钥完成其余四个服务的真实接口验收
- [x] RFC 0029 镜头预演，步骤 a、b：画布卡片与全屏画格编辑器，支持压感画笔、橡皮、颜色、大小和会话内撤销；可编辑备注、时长和宽高比；支持文件选择、拖入、粘贴、按文件名排序的多图导入，以及从画布图片填充。保存使用内容哈希保证上传重试不重复建素材，并提供版本冲突提示。网关禁止 Agent 修改已有画格图片。步骤 b 将全屏编辑器限定为免费预演，画布浮层分为免费预演设置与成品生成两个区域，需密钥的服务显示付费标记；增加横向画格条、画布画格操作、镜头关联与顺序关联预览、分镜表画格缩略图、Agent 草稿，以及带丢弃提示的批次构图参考；完成图画格在批次中幂等复用，不重复生成。按需加载的 previz 指南说明阅读和询问规则。步骤 c 增加卡片与编辑器中的“渲染预演”草稿操作（编辑器先保存再关闭）、本地 three.js 白模预演、按需播放的海报预览、可重试一次版本冲突的画面提取，以及分镜表中明确标示“仅预演”的白模缩略图和简短 Agent 指南。假 Codex 走通真实本地渲染与提取，白模画面用于模拟批次的构图输入，用户原图保持可见。白模视频使用独立的 `previz` 镜头角色，不计入成品批次输出与组装时间线。整页拆分、100 格性能测量、真实 Agent／模型验收与 Windows WebGL 测量仍待后续完成，视频参考在 RFC 0043 中恢复推进。
- [x] RFC 0032 [回合视图、立即发送与子工作区工作文档](docs/rfc/0032-turn-view-send-now-working-docs.md)：连续思考、计划和工具调用合为可展开的工作块，生成结果卡片保持常驻；“立即发送”停止当前回合并优先发送指定排队消息，工作消息顺序不丢失；网关强制子工作区文本（含代码）作为工作文档，回报链接可临时打开隐藏文档。单独提交的生成任务在中断后继续执行。
- [x] RFC 0031 [长文写作页](docs/rfc/0031-manuscript.md) 第 a 步：CodeMirror 章节大纲与居中阅读栏、逐个汉字计数、带版本校验的防抖自动保存、冲突保护和版本历史；TXT（UTF-8 / GB18030）、Markdown 与 DOCX 导入先预览，再插入光标处或创建画布文本节点。长文性能及版本存储增长实测记录在 RFC 中；第 b 步已支持选区操作直接发送到当前 Agent、持久化锚定建议与行内逐处或批量审阅、原子化接受、失效建议保护、网关保护作者正文（Agent 删除须经绑定版本的用户授权），以及同系列前集正文只读访问；第 c 步已支持选区或章节拆成带原文来源的分镜、分镜与原文双向定位（同一行合并为侧栏标记）、紧凑选区工具栏与“更多”菜单中的生产操作、保留已有同名设定的人物与场景提取，以及按章节创建系列分集、逐章报告结果并在部分失败后跳过成功章节重试，原稿始终保留。Markdown 实时预览会隐藏非活动可见行的语法标记，在光标、选区、审阅或分镜原文所在行显示源码，并保持原文与有界渲染。
- [x] RFC 0033 作者 Skill 库第 a 步：Agent 仅按作者要求起草，在「设置 › 我的 Skill」编辑、保存或丢弃；稳定 ID 与不可变内容哈希版本，明确使用后复制到项目 `skills/` 并保留来源，不覆盖同名内容。Agent 无权保存到库；跨项目使用与正文到达回合已由 fake Codex 验证。第 b 步已支持独立副本状态、带哈希校验的更新/发布/重置及丢弃修改确认、可选的新项目默认使用、仅生成草稿的 Markdown 导入、SKILL.md 导出、可恢复删除，以及带审阅和丢弃操作的实时会话草稿卡。「保存为 Skill」只填入可编辑请求，不自动发送。
- [x] RFC 0034 [Agent 请求清理子工作项](docs/rfc/0034-agent-requested-work-cleanup.md)：根工作区 Agent 可按作者要求请求删除直接子项；作者单次点击授权，绑定卡片所示影响，十分钟到期或影响增加即失效，画布内容与素材保留。授权不会唤醒请求的 Agent。
- [x] RFC 0035 [静默回合与可靠停止](docs/rfc/0035-silent-turn-watchdog.md)：十分钟无活动（工具尚未返回时三十分钟）后，在工作块与看板提示，恢复活动立即清除；每个子回合只通知上级一次，不自动停止。停止和立即发送会在宽限期内强制结束无响应回合，清理审批和队列并终止进程树；回收和删除共用此路径。
- [x] RFC 0038 [子项未报告便结束回合](docs/rfc/0038-unreported-child-turns.md)：子项正常结束却没有报告时，每个已投递批次发送一条持久通知，附上未结束的生成任务数量和最后回复片段；有进行中或排队工作时延后检查，生成任务不延后通知。看板提示在下一子回合或报告后清除，最多唤醒上级两次，报告或作者本人操作重置次数，后续通知只进作者收件箱。
- [x] RFC 0036 [本机透明视频](docs/rfc/0036-transparent-render.md)，步骤 a、b：`render` 支持 `transparent: true` 输出带透明通道的 WebM；探测到的透明信息用于画布、会话结果和预览中的棋盘格，时间线叠加保留透明度。视频下载菜单支持本机导出 ProRes 4444 MOV，提供大小预估、取消与临时文件自动清理，不创建素材版本。
- [x] RFC 0030 [会话里的生成结果](docs/rfc/0030-session-results.md)：每个生成任务在最后一次工具提及处、工作块之外显示一张常驻卡片，包含图片缩略图、视频封面和音频条，运行中、失败和取消状态也直接显示；可以预览、定位到画布，或引用到下一条消息；视频平时只显示封面，点开预览才加载播放器；Agent Markdown 里的图片一律不加载，外部地址显示为链接
- [x] 开源准备（RFC 0028 并行事项）：已实现 GitHub Actions CI 和 [CONTRIBUTING.md](CONTRIBUTING.md)；PR 和 main 跑 Linux 检查、构建与 e2e，main 和手动触发另跑 Windows/macOS 检查与构建；托管 Linux 的检查、构建和逐文件运行的 e2e 已通过；安全策略、行为准则、模板以及不公开历史的发布方式由 RFC 0042 完成；第三方许可证审计和无付费 Key 的首次使用路径仍未完成
- [x] README 截图换成中英文两套新图，来自可复现的截图脚本（`pnpm --filter @vis/web readme-shots`：隔离的守护进程、本机渲染与 Mock 服务、假 Codex）
- [x] 真实使用修正：聊天长消息完整显示；Markdown 卡片尺寸更易读，写作页按可见范围排版并显示可编辑表格；子工作失败通知上级；滞留消息可明确重开后发送或撤回；看板跨项目打开会话；整理时可选移除空框并整体撤销。
- [x] RFC 0039 [生成来源与重新生成](docs/rfc/0039-generation-provenance-and-regenerate.md)（已实现）：生成出来的新节点保留提示词、参考图和设置；提示词面板显示模型真正使用的提示词（服务商返回改写版本时显示改写后的，否则显示发送的提示词），并可把某一版的设置恢复到草稿；节点工具栏新增「重新生成」，用相同设置生成新版本；参数名称和说明由各模型自己的参数定义提供中英文，新增模型无需修改画布界面
- [x] RFC 0040 [生成类操作先确认再提交](docs/rfc/0040-confirmed-generation-operations.md)（已实现）：工具栏上的放大、扩图、重拍等生成类操作不再一点就提交，而是打开提示词面板；作者从已配置且支持该操作的模型中选择，调整该操作自己的参数，操作支持时填写提示词，确认后才提交；每个模型按操作声明参数和提示词规则，新增操作无需修改画布界面
- [x] RFC 0041 [ACP Agent：MiniMax Code 与 CodeBuddy](docs/rfc/0041-acp-agents.md)（已完成）：通用 ACP 运行时与 DeepSeek 等行为迁移已完成；MiniMax Code（`mcode acp`）和 CodeBuddy（`codebuddy --acp`，WorkBuddy 的底层引擎）已实现，采用保守的只读降级策略，维护者已于 2026-11-10 在真实会话中验收两者；CodeBuddy 审批分类以已识别的原生工具身份为准。重启后的默认模型探测先完成，再恢复回合的会话。ACP 回合连续十分钟没有活动时会提示失败并停止进程，等待审批期间暂停计时。豆包因缺少结构化协议和交互式审批、工具运行在沙箱之外而暂缓。
- [ ] RFC 0042 [开源实践](docs/rfc/0042-open-source-practices.md)（已实现；仓库已于 2026-11-13 公开；有第二位贡献者后再启用先开 issue 的流程）：在 `pnpm check` 和可选 git 钩子中加入隐私检查，命中时只报类型和位置、不打印内容，个人词表只保存在本机；把 `main` 的快照以 noreply 身份、经检查后用脚本发布到公开仓库；提供 issue 与 PR 模板、代码负责人和安全策略；在 `docs/lessons/` 按主题记录踩坑；有第二位贡献者后再启用先开 issue 的流程
- [x] RFC 0043 [视频参考与媒体托管](docs/rfc/0043-video-references-and-media-hosting.md)（步骤 a–d；2026-11-11 使用托管参考的真实方舟任务通过）：独立可选的 TOS 媒体托管设置和仅 UI 可用的托管接口；Seedance 2.0/2.5 视频参考及 Seedance 2.5 模型注册；提示词面板按模型目录读取参考限制与托管状态，显示封面和时长、提交前数量与时长校验、媒体托管设置入口及计费 token 提示。参考编号按媒体类型分别计数，提交时将节点标记转换为 Seedance 2.0/2.5 文档中的引用名称。生成指南说明各模型的参考命名、首尾帧与参考素材互斥，以及真人面孔拒绝规则。§9 唯一一次真实 TOS/方舟验收仍需维护者批准。
- [x] RFC 0037 [可交互 3D 场景节点](docs/rfc/0037-interactive-scene-nodes.md)：步骤 a 已完成，包含场景节点和编辑器，支持人偶、道具、导入的 `.glb` 模型，以及可保存为图片或发送到画格的机位。步骤 b 的姿势也已完成：可在视口或检查器里选择关节，在限位内旋转，套用站立、行走、坐姿、指向预设，并左右镜像。方向键和 PageUp/PageDown 可按当前工具、相对机位微调选中的物体或关节，每按一次是一步撤销。步骤 c 加入运动：每个场景一条时钟，可给物体变换、人偶关节、可见性和每个机位的相机打关键帧，每个关键帧单独选缓动（线性、缓入缓出或保持），时间轴条支持播放和逐帧，“渲染视频”在本地通过 `render/scene` 把当前机位渲染成以场景为输入的视频节点。步骤 d 让 Agent 可以创建场景，但只能改动自己创建且作者未动过的物体和机位；归属由网关标记，其他改动一律拒绝，场景指南覆盖人体、组合物体、运动和渲染单帧自查。Codex 评测已完成；Agent 是否真的查看了渲染结果无法从对话记录确认（已列为已知限制）。假 Codex 浏览器测试通过 MCP 覆盖受保护的写入和删除拒绝；MCP 会把网关的恢复提示传给 Agent
- [x] RFC 0044 [场景修改建议](docs/rfc/0044-scene-change-proposals.md)（已实现）：场景里的物体、机位或时长受保护时，Agent 调用 `scene.propose` 提交修改建议，而不只是口头描述。作者可在对话里的卡片上接受或拒绝，也可在场景编辑器的“修改建议”区逐条决定，并在播放头位置预览建议后的场景（转动相机和拖动播放头不会退出预览）。接受属于作者自己的写入，在一个事务内完成，物体仍保持受保护；作者先改动了该物体，对应建议就会失效，同一物体的新建议会取代旧建议，场景卡片显示待处理数量。处理建议不会给 Agent 发消息
- [x] RFC 0045 [模型文档链接](docs/rfc/0045-model-doc-links.md)（已实现）：每个内置生成模型都附上厂商官方的提示词指南和 API 参考链接，随模型出现在 `providers.list` 中；Agent 为某个模型写第一条提示词前先打开最新页面，作者的指示和技能仍优先于厂商建议。只放链接：仓库不复制厂商原文，也无需同步
- [x] RFC 0047 [结果占位节点](docs/rfc/0047-result-placeholders.md)（已实现）：没有指定目标的生成结果在提交时就在画布上建好空节点，显示生成中，位置不再变；产物填入该节点，失败显示在它上面，取消时若仍为空则移除。回执里带节点 ID，Agent 可以立刻为它命名或连线
- [x] RFC 0048 [Agent 自带能力](docs/rfc/0048-agent-native-capabilities.md)（已实现）：Agent 保留自己的能力，产品只守硬性边界（密钥、费用、网关权限、工作目录之外的写入、不渲染 HTML）。Codex 开启实时网页搜索并在会话里显示，自动审批放行 Agent 自带的只读网页搜索与读取，生成指南要求 Agent 真正读取模型文档，判定页面无法访问前必须写明网址和错误
- [x] RFC 0049 [Child session model and effort](docs/rfc/0049-child-agent-model.md) (implemented): on author or author-written skill/workflow direction, Agents discover exact model, effort and service-tier ids, configure a new or existing direct child, and read back its settings; self configuration stays UI-only; indexed session labels include effort-only and speed-only settings, resolve catalogs without blocking review, and keep session-button accessible names stable
- [ ] 已知问题：Windows 上的测试稳定性和一些 UI 小问题，清单见 [docs/known-issues.md](docs/known-issues.md)
- [ ] 负载下的性能：Windows 上机器负载高时，单测和浏览器测试会超时（页面加载超过 5 秒、每个测试文件各自启动 studiod 和 Chrome）；浏览器 e2e 已改为同时跑 4 个文件，准备阶段的超时消失、总时长不变；下一步测量启动、首屏加载和单测并行度，并确认应用本身是否也会变慢
- [ ] 「释放」：空闲时关闭项目（RFC 0011 推迟）
- [ ] RFC 0046 [桌面应用](docs/rfc/0046-desktop-app.md)（步骤 a、b、c1、c2 已完成：运行前提、源码外壳、临时签名的 arm64 DMG 打包和独立的打包验收测试，以及随包附带的、从源码构建的 macOS LGPL ffmpeg 工具包；Windows x64 NSIS 打包沿用同一套暂存流程，随附在 GitHub Actions 上用相同锁定源码交叉编译的 LGPL ffmpeg；预览版以 GitHub 预发布版发布，Apple 芯片最新为 2026-11-13 的 [0.1.0-preview.2](https://github.com/aliuda/visCreative/releases/tag/v0.1.0-preview.2)，首个 Windows 版为 2026-11-14 的 [0.1.0-preview-win.1](https://github.com/aliuda/visCreative/releases/tag/v0.1.0-preview-win.1)）：基于 Electron 的 macOS（Apple 芯片与 Intel）和 Windows 应用，自行启动 studiod，并在主进程内运行现有网页宿主，界面包不改；内置 LGPL 版 ffmpeg 和字幕字体，以书面说明提供单独托管的源码，在用户 PATH 之后向 Agent 提供内置 ffmpeg 后备，并从登录 shell 读取 PATH，从访达启动时也能找到 Agent 命令行。步骤：studiod 运行前提、外壳、打包、未签名预览版（Windows 自动更新，macOS 提示有新版本），最后是签名并公证的正式版

## 致谢

visCreative 的大部分开发是在 [Orca](https://github.com/stablyai/orca)（[onorca.dev](https://www.onorca.dev/)）里完成的。Orca 是一个开源的多 Agent 并行开发环境：Claude Code 负责设计与审阅，多个 Codex 执行者在各自的 worktree 里实现任务。开发在私有仓库中进行，再以合并后的快照发布到本仓库；快照包含 Claude 或 Codex 参与编写的改动时，会用 `Co-Authored-By` 署名它们。每天这样协作的体验，直接影响了本项目的工作项设计：协调者派发给执行者，消息回流到收件箱，经过人的审阅才算完成。感谢 Orca 团队。

画布基于 [React Flow](https://reactflow.dev)（MIT 许可）。界面里隐藏了它的署名角标，所以在这里致谢。

## 许可证

[MIT](LICENSE) © 2026 aliuda
