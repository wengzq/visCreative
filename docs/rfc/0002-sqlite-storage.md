# 0002 · 以 SQLite 作为存储真源

状态：已决定（存储方向）/ 表结构为草案，待评审

日期：2026-10-26

0010 更新：2026-10-28。工作项、全局名额与消息批次沿用 [0009](0009-work-items-and-board.md)；画框绑定和会话角色按 [0010](0010-workspaces-without-canvas-binding.md) 移除，实际投递与批次确认已接入会话队列。

取代：[0001](0001-multi-agent-creative-space.md) 第四章中“画布工程格式与读写协议”“操作批次的保存与崩溃恢复”两节的存储方案。0001 原文保留，用于追溯；其中的语义约束（快照、修订、回填资格、幂等）继续有效，只是改由 SQLite 实现。

## 决定

- 业务状态的唯一真源是 SQLite。一个操作批次就是一个 SQLite 事务；WAL 模式负责崩溃后恢复，不再自建文件事务目录和恢复流程。
- 驱动使用 `better-sqlite3`，查询层与迁移使用 Drizzle。
- 只有 studiod 打开数据库。UI、CLI 一律经 RPC 访问，不存在第二个写者。
- 可读的工程文件（JSON + Markdown）只作为导出产物，不是真源。

## 理由

0001 同时要求三件事：工程文件是正式真源、多文件原子提交、业务变化与事件在同一事务中登记。在文件系统上同时满足这三点，需要自行实现两阶段提交和恢复流程，实现和故障测试成本都很高，断电安全也无法保证。SQLite 原生提供原子事务和崩溃恢复，而“回填检查 + 写槽位 + 登记事件”在同一个事务里完成，正好满足 0001 反复强调的“检查与写入一致”。

放弃的部分及弥补方式：

| 放弃 | 弥补 |
|---|---|
| Agent 直接读工程文件 | 通过 CLI 读取当前状态或固定快照（`vis canvas get --json` 等） |
| 用 Git 比较差异 | 导出为可读工程，作为派生产物 |
| 用外部编辑器直接修改 | MVP 本就推迟；以后通过导入或变更校验实现 |

## 目录布局

```
<应用数据目录>/
├─ app.db                    全局：空间列表、最近打开、非敏感配置
└─ spaces/<spaceId>/
   ├─ space.db               该空间全部业务状态
   └─ blobs/ab/abcd…ef       媒体文件，按 SHA-256 内容寻址，写入后不可变
```

- 每个空间一个库：对应 0001“每个空间串行提交写入批次”；不同空间互不阻塞，备份或删除一个空间就是处理一个目录。
- API 密钥不进任何数据库，由 Electron `safeStorage` 或系统钥匙串保存，只有 studiod 能读。

## 文件与数据库的边界

媒体文件不放进数据库。下载或导入的顺序是：

1. 写入临时文件，并 fsync 落盘；
2. 计算哈希，重命名到 `blobs/` 下的内容路径（同一哈希已存在则丢弃临时文件）；
3. 在一个事务里登记 blob、素材版本，并完成回填。

崩溃只会留下未被引用的 blob，不会出现“库里有记录、文件却不存在”。孤儿 blob 定期清理，规则待定。

## 约定

- 主键为带类型前缀的 ULID 文本，例如 `node_01J…`、`slot_01J…`。标识永不复用。
- 时间统一为 Unix 毫秒整数。JSON 存为 TEXT。
- 节点和槽位删除用 `deleted_at` 标记（墓碑），以便恢复引用、拒绝迟到的回填。
- PRAGMA：`journal_mode=WAL`、`foreign_keys=ON`、`synchronous=FULL`。0001 要求“提交决定持久化之后才返回成功”，所以选 FULL；桌面场景写入量小，性能代价可以接受。

## space.db 表结构草案

### 会话与运行

```sql
CREATE TABLE work_items (
  id                 TEXT PRIMARY KEY,         -- work_…
  parent_id          TEXT REFERENCES work_items(id),
  title              TEXT NOT NULL,
  brief              TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'todo', -- todo | in_progress | in_review | done
  pinned             INTEGER NOT NULL DEFAULT 0,
  review_by          TEXT NOT NULL DEFAULT 'user', -- user | parent
  work_dir           TEXT NOT NULL,
  created_by         TEXT NOT NULL,            -- JSON：user 或 agent + sessionId
  revision           INTEGER NOT NULL DEFAULT 1,
  activation_seq     INTEGER,                  -- 本轮激活的空间事件基线
  waiting_slot_since INTEGER,                  -- 非空：请求激活但正在等名额
  pending_feedback   INTEGER NOT NULL DEFAULT 0, -- 满额时保留打回/重开意见的待处理状态
  agent_kind         TEXT,                     -- 尚未建会话的工作项可为空
  status_changed_at  INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  archived_at        INTEGER
);
CREATE INDEX work_items_parent ON work_items(parent_id);
CREATE INDEX work_items_waiting_slot ON work_items(waiting_slot_since);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  agent_kind      TEXT NOT NULL,               -- codex | deepseek | claude
  title           TEXT NOT NULL,
  work_item_id    TEXT REFERENCES work_items(id), -- SQL 可空；线上创建路径必须关联
  work_dir        TEXT NOT NULL DEFAULT '',    -- 兼容镜像，工作目录归 work_items 所有
  title_source    TEXT NOT NULL DEFAULT 'default', -- default | user | agent
  agent_resume_id TEXT,                        -- Claude SDK 会话 ID，用于恢复上下文
  provider_leaf_uuid TEXT,                     -- Claude 记录中最后一条已确认消息的 uuid，崩溃核对的锚点
  queue_paused    INTEGER NOT NULL DEFAULT 0,  -- Stop 后暂停自动发送
  created_at      INTEGER NOT NULL,
  archived_at     INTEGER
);

CREATE TABLE work_messages (
  id                TEXT PRIMARY KEY,         -- wmsg_…
  work_item_id      TEXT NOT NULL REFERENCES work_items(id),
  kind              TEXT NOT NULL,            -- brief | done | question | blocked | escalation | reply | review_feedback | recall
  "from"            TEXT NOT NULL,            -- JSON：user | session + sessionId | system
  "to"              TEXT NOT NULL,            -- parent | child | user
  body              TEXT NOT NULL,
  refs              TEXT NOT NULL DEFAULT '{}', -- JSON：nodeIds / assetVersionIds
  reply_to          TEXT REFERENCES work_messages(id),
  delivery_id       TEXT,                     -- 同一次会话注入的批次 ID
  resolved_by       TEXT REFERENCES work_messages(id),
  redelivered       INTEGER NOT NULL DEFAULT 0,
  target_session_id TEXT REFERENCES sessions(id), -- 内部路由字段，不放入 WorkMessageView
  created_at        INTEGER NOT NULL,
  delivered_at      INTEGER,
  acked_at          INTEGER,
  read_at           INTEGER
);
CREATE INDEX work_messages_item_created ON work_messages(work_item_id, created_at);
CREATE INDEX work_messages_session_delivery ON work_messages(target_session_id, delivery_id);

-- 运行实例：一个会话同时最多一个有效实例
CREATE TABLE agent_instances (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  status      TEXT NOT NULL,                   -- starting | ready | exited
  pid         INTEGER,
  token_hash  TEXT NOT NULL UNIQUE,            -- 运行令牌的哈希，见 0003“调用方身份”
  started_at  INTEGER NOT NULL,
  exited_at   INTEGER,
  exit_reason TEXT
);
CREATE UNIQUE INDEX agent_instances_one_active
  ON agent_instances(session_id) WHERE status IN ('starting', 'ready');

-- 用户消息：待发草稿与正式提交共用一张表，用 delivery_state 区分
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  text           TEXT NOT NULL,
  delivery_state TEXT NOT NULL,                -- draft | submitted | delivered | unknown | rejected | withdrawn
  queue_order    REAL,                         -- 草稿排序，便于插入调整
  created_at     INTEGER NOT NULL,
  submitted_at   INTEGER
);
CREATE INDEX messages_session_state ON messages(session_id, delivery_state);

-- 消息里的引用意图：引用哪个对象、按什么策略取版本
CREATE TABLE message_refs (
  message_id      TEXT NOT NULL REFERENCES messages(id),
  ordinal         INTEGER NOT NULL,
  node_id         TEXT NOT NULL,
  slot_id         TEXT,
  version_policy  TEXT NOT NULL,               -- latest-at-execution | pinned
  pinned_revision INTEGER,
  PRIMARY KEY (message_id, ordinal)
);

-- 回合：一条正式提交的一次执行
CREATE TABLE turns (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  message_id        TEXT NOT NULL UNIQUE REFERENCES messages(id),
  instance_id       TEXT REFERENCES agent_instances(id),
  input_snapshot_id TEXT REFERENCES input_snapshots(id),
  status            TEXT NOT NULL,             -- running | waiting_user | completed | failed | interrupted
  started_at        INTEGER,
  ended_at          INTEGER
);

-- 会话记录：Agent 输出、工具调用等，供界面展示。流式输出原地更新同一条目
CREATE TABLE transcript_entries (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  item_id     TEXT NOT NULL,
  created_seq INTEGER NOT NULL,                -- 首次创建时的序号，决定显示顺序
  revision    INTEGER NOT NULL,                -- 只接受更高修订，迟到的旧修订丢弃
  turn_id     TEXT REFERENCES turns(id),
  kind        TEXT NOT NULL,                   -- user | assistant_text | tool_call | tool_result | notice
  payload     TEXT NOT NULL,                   -- JSON
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, item_id),
  UNIQUE (session_id, created_seq)
);
```

消息投递、回合执行、进程实例分别对应 `messages.delivery_state`、`turns.status`、`agent_instances.status`，即 0001 所说的三个独立维度。

W1 的 `sessions.work_item_id` 保留可空外键，兼容旧的直接插表调用与测试夹具；协议的 `SessionSummary.workItemId` 同样保留 nullable。这个存储兼容口不改变线上不变量：迁移会为每个已有会话补建一个无框的根工作项，未归档会话对应 `in_progress`，已归档对应 `done`；`session.create`、`work.create({ chat })`、`work.dispatch` 与首次激活新建的会话都写入实际关联。摘要从数据库读取工作项关联，不再包含角色。普通直接 SQL 写入不保证这一业务不变量，不能用 nullable 表示线上新建会话无需工作项。

`session.create` 在一个空间事务内写入根工作项及会话。已占名额时进入 `in_progress` 并记录激活基线，名额满时进入 `todo` 并设置 `waiting_slot_since`。`sessions.work_dir` 作为兼容镜像保留，运行时目录优先读取工作项目录。

#### 工作消息批次接口

以下函数由 `@vis/storage` 导出；`tx: SpaceTx` 可与会话队列写入放在同一个立即写事务内。`WorkMessageRow` 是存储行，`WorkMessageBatch = { deliveryId: string; messages: WorkMessageRow[] }`。

```ts
claimWorkMessages(tx: SpaceTx, sessionId: string, deliveryId: string): WorkMessageRow[]
markWorkMessagesDelivered(tx: SpaceTx, sessionId: string, deliveryId: string, now?: number): number
replayWorkMessages(tx: SpaceTx, sessionId: string): WorkMessageBatch[]
ackWorkMessages(tx: SpaceTx, sessionId: string, deliveryId: string, now?: number): number
readWorkMessageBatch(tx: SpaceTx, sessionId: string, deliveryId: string): WorkMessageRow[]
```

- `claim` 只领取目标会话中尚无批次、尚未确认、并非发给用户的消息；调用方提供全新的批次 ID，已存在的批次 ID 返回 `invalid_params`，不能追加消息或改投其他会话。返回值按创建时间及 ID 排序。
- `mark…Delivered` 在回合真正开始时设置首次 `delivered_at`；重复调用不会覆盖时间，返回修改行数。
- `replay` 恢复未确认的已有批次，保留 `delivery_id`；已开始投递过的消息标记 `redelivered`。它不自行向 Agent 发消息。
- `ack` 只确认该会话、该批次中已经开始投递的消息，应与成功回合结束放在同一个事务中。首次确认同时登记 `work.messageAcked`，载荷为 `{ deliveryId, sessionId, messageIds, ackedAt }`；重复确认不覆盖时间、不再发事件。`read…Batch` 按会话与批次读取有序记录。

`SessionService.notifyWorkActivated(sessionId: string): void` 唤醒待投递工作消息与既有用户草稿；只有关联工作项为 `in_progress`、会话未暂停且未归档时才出队。回合成功结束与批次确认同事务。报告投递到父项主会话，回复、打回意见与回收投递到子项主会话；主会话是按 `created_at`、ID 升序的第一个未归档会话。

#### 会话记录与 Claude 上下文的分工

参考 Orca（1.4.197 源码静态阅读）的做法，两份记录各管一件事，不强求一致：

| 记录 | 回答的问题 |
|---|---|
| `transcript_entries` | 界面显示什么。压缩上下文后仍保留完整历史 |
| Claude SDK 的会话记录（JSONL） | Claude 下一轮实际带着什么上下文；恢复会话时以它为准 |

- 上下文被压缩时，在会话记录中插入一条 `notice`（“上下文已压缩”），让用户知道 Agent 不再记得全部细节。
- 崩溃恢复（MVP）：重启后把 `submitted` 但未确认的消息标为 `unknown`，由用户决定是否重试；重试生成新的消息 ID，原消息标为 `withdrawn`。**绝不自动重发。**
- 推迟：读取 Claude JSONL、以 `provider_leaf_uuid` 为锚点自动判定 `delivered` / `rejected`；需要处理分叉、压缩、文件末尾不完整等情况。`provider_leaf_uuid` 现在就开始记录，以便以后使用。
- 推迟：会话记录的“代次”与整体重建（Orca 用于损坏修复与 rewind）。需要时给 `transcript_entries` 加一列即可。

### 画布

```sql
CREATE TABLE nodes (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,               -- image | video | text | frame
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  z               REAL NOT NULL,
  layout_revision INTEGER NOT NULL DEFAULT 1,
  frame           TEXT,                        -- JSON：{ title, color }，仅 frame 节点
  frame_id        TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE TABLE slots (
  id                  TEXT PRIMARY KEY,
  node_id             TEXT NOT NULL REFERENCES nodes(id),
  slot_key            TEXT NOT NULL,           -- MVP 单槽组件固定为 'main'
  content_type        TEXT NOT NULL,           -- image | video | text
  current_revision    INTEGER NOT NULL DEFAULT 0,  -- 0 表示空槽
  accepted_binding_id TEXT,                    -- 当前接受的生成请求；见 delivery_bindings
  deleted_at          INTEGER,
  UNIQUE (node_id, slot_key)
);

-- 槽位内容的每一次修订都保留一行。文本与媒体统一走这张表
CREATE TABLE slot_revisions (
  slot_id          TEXT NOT NULL REFERENCES slots(id),
  revision         INTEGER NOT NULL,
  asset_version_id TEXT REFERENCES asset_versions(id),
  text_body        TEXT,                       -- Markdown 源文
  operation_id     TEXT NOT NULL REFERENCES operations(id),
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (slot_id, revision),
  CHECK (asset_version_id IS NULL OR text_body IS NULL)  -- 都为空表示“清空”
);
```

`slot_revisions` 顺带解决了 0001 中“文本的存储位置与素材版本的统一方式待设计”：文本和媒体都是槽位的一次修订。撤销虽然推迟，但槽位的内容历史已经完整保留。

`frame` 节点没有槽位；其他节点按中心点归入最内层的框。移动或删除框后会重新计算归属，删除框保留内容。框只是项目画布的整理节点，不关联工作项，也不划分 Agent 写入权限。

0010 迁移删除 `work_items.frame_node_id`、`sessions.role` 及两个角色唯一索引，清除框 JSON 的 `workItemId`，保留全部节点和布局。`review_by: coordinator` 改为 `parent`，消息 `to: coordinator/worker` 改为 `parent/child`，会话来源里的 `role` 删除，未确认消息仍可投递。旧 `canvas_outside_frame` 待审批记录过期，对应回合收到拒绝，按节点授权的旧放行记录同时清理。

### 素材

```sql
CREATE TABLE blobs (
  hash       TEXT PRIMARY KEY,                 -- SHA-256，对应 blobs/ 下的路径
  byte_size  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE assets (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,                  -- image | video
  origin       TEXT NOT NULL,                  -- import | generation
  display_name TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE asset_versions (
  id            TEXT PRIMARY KEY,
  asset_id      TEXT NOT NULL REFERENCES assets(id),
  version       INTEGER NOT NULL,
  blob_hash     TEXT NOT NULL REFERENCES blobs(hash),
  mime          TEXT NOT NULL,
  width         INTEGER,
  height        INTEGER,
  duration_ms   INTEGER,
  source_job_id TEXT REFERENCES generation_jobs(id),  -- 生成来源
  created_at    INTEGER NOT NULL,
  UNIQUE (asset_id, version)
);
```

### 执行快照

```sql
CREATE TABLE input_snapshots (
  id         TEXT PRIMARY KEY,
  turn_id    TEXT NOT NULL REFERENCES turns(id),
  created_at INTEGER NOT NULL
);

-- 每个引用解析到的确切版本。因为 slot_revisions 和 blob 都不可变，快照只需记录指针
CREATE TABLE snapshot_items (
  snapshot_id   TEXT NOT NULL REFERENCES input_snapshots(id),
  ordinal       INTEGER NOT NULL,
  node_id       TEXT NOT NULL,
  slot_id       TEXT NOT NULL,
  slot_revision INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, ordinal),
  FOREIGN KEY (slot_id, slot_revision) REFERENCES slot_revisions(slot_id, revision)
);
```

### 生成任务与交付

```sql
CREATE TABLE generation_jobs (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(id),
  turn_id             TEXT REFERENCES turns(id),
  input_snapshot_id   TEXT REFERENCES input_snapshots(id),  -- 继承本次执行的固定输入
  kind                TEXT NOT NULL,           -- image | video
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  params              TEXT NOT NULL,           -- JSON
  status              TEXT NOT NULL,           -- queued | running | finalizing | succeeded | failed | unknown
  error               TEXT,                    -- JSON
  cancel_requested_at INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- 本次生成实际使用的输入：快照内沿用快照修订，快照外在提交时固定（见 0003）
CREATE TABLE job_inputs (
  job_id        TEXT NOT NULL REFERENCES generation_jobs(id),
  ordinal       INTEGER NOT NULL,
  slot_id       TEXT NOT NULL,
  slot_revision INTEGER NOT NULL,
  from_snapshot INTEGER NOT NULL,              -- 1：来自回合快照；0：提交时固定
  PRIMARY KEY (job_id, ordinal),
  FOREIGN KEY (slot_id, slot_revision) REFERENCES slot_revisions(slot_id, revision)
);

CREATE TABLE generation_attempts (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES generation_jobs(id),
  attempt_no       INTEGER NOT NULL,
  external_task_id TEXT,                       -- 有它才能在超时后查询，而不是重发
  status           TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  error            TEXT,
  UNIQUE (job_id, attempt_no)
);

-- 产物登记：(job_id, output_index) 唯一，重复通知或恢复重试不会重复登记
CREATE TABLE generation_outputs (
  job_id           TEXT NOT NULL REFERENCES generation_jobs(id),
  output_index     INTEGER NOT NULL,
  asset_version_id TEXT NOT NULL REFERENCES asset_versions(id),
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (job_id, output_index)
);

-- 结果绑定：在执行生成之前持久化。绑定 ID 就是 0001 中的 generationRequestId
CREATE TABLE delivery_bindings (
  id                        TEXT PRIMARY KEY,
  job_id                    TEXT NOT NULL REFERENCES generation_jobs(id),
  output_index              INTEGER NOT NULL,
  target_kind               TEXT NOT NULL,     -- slot | new_node
  node_id                   TEXT,              -- target_kind = slot 时必填
  slot_id                   TEXT,
  expected_content_revision INTEGER,
  placement                 TEXT,              -- new_node 时的放置提示（JSON）
  status                    TEXT NOT NULL,     -- pending | delivered | conflict | target_missing | no_output
  delivered_operation_id    TEXT REFERENCES operations(id),
  created_node_id           TEXT REFERENCES nodes(id),
  UNIQUE (job_id, output_index)
);
```

回填在同一个事务里完成，检查 0001 列出的四个条件：

1. 目标节点和槽位存在、未删除，且类型兼容；
2. `slots.current_revision` 等于 `expected_content_revision`；
3. `slots.accepted_binding_id` 等于本绑定的 ID；
4. 绑定状态仍是 `pending`。

全部满足就写入新的 `slot_revisions`、更新槽位、把绑定标为 `delivered`、登记事件。任何一条不满足，产物照样保留为素材，绑定标为 `conflict` 或 `target_missing`。Job 结束（成功、失败或未知）时仍为 `pending` 的绑定标为 `no_output`：Provider 返回的产物少于请求数量时，缺的位置不会再交付。

`new_node` 类型交付的落点：放在本次执行所引用节点的旁边（`placement` 记录参考节点 ID），右侧被占用时向下寻找空位；参考节点已删除或不存在时，放进空间的结果区域。MVP 中结果区域暂定为“现有内容的右侧”，最终形态待画布交互设计。

### 操作、幂等与事件

```sql
-- 每个已提交的操作批次一行。MVP 用于审计与关联；撤销所需的变更明细以后再加
CREATE TABLE operations (
  id               TEXT PRIMARY KEY,           -- operationId，由调用方提供，重试时复用
  actor_kind       TEXT NOT NULL,              -- user | agent | system
  actor_session_id TEXT REFERENCES sessions(id),
  description      TEXT,
  created_at       INTEGER NOT NULL
);

-- RPC 级幂等：同一 requestId 同内容返回原结果，内容不同则报冲突
CREATE TABLE idempotency_keys (
  request_id  TEXT PRIMARY KEY,
  method      TEXT NOT NULL,
  fingerprint TEXT NOT NULL,                   -- 请求参数的哈希
  result      TEXT,                            -- JSON
  created_at  INTEGER NOT NULL
);

-- 持久化事件：与业务修改在同一事务内登记
CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,  -- 空间内递增，即订阅游标
  type         TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  payload      TEXT NOT NULL,                  -- JSON；图片、视频只传引用
  operation_id TEXT REFERENCES operations(id),
  created_at   INTEGER NOT NULL
);
```

界面打开或重连时，在同一个读事务里读取当前状态和 `MAX(seq)`，再订阅这个序号之后的事件。流式文本片段等瞬时事件不落库，只走内存推送。

## app.db 表结构草案

```sql
CREATE TABLE spaces (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  dir            TEXT NOT NULL,                -- 空间目录
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                          -- JSON；包括 Provider 启用状态、默认模型、接口地址，不含密钥
);

CREATE TABLE work_slots (
  work_item_id TEXT PRIMARY KEY,               -- 跨库标识；不能对 space.db 建 SQL 外键
  space_id     TEXT NOT NULL REFERENCES spaces(id),
  acquired_at  INTEGER NOT NULL
);
CREATE INDEX work_slots_space ON work_slots(space_id);
```

`work_slots` 只记录 `in_progress` 工作项的全局占额；默认上限 6，项目可选上限存在 `settings` 的 `work.slotLimit.<spaceId>`，全局上限存在 `work.slotLimit`。占用和释放在 app.db 的立即写事务里串行执行；app.db 与 space.db 没有跨库原子事务，空间写入失败须补偿释放。启动时读取全部已登记项目的工作项并重建占额；已有占额却缺库或数据库无法读取时中止启动，不能静默漏算。排队标记仍在各项目的 `work_items.waiting_slot_since` 中，释放或提高上限后按等待时间尝试补位。

## 待评审

1. 孤儿 blob、`idempotency_keys`、事件的清理周期：等 MVP 跑起来看实际数据量再定。
2. 撤销上线时，`operations` 需要补充变更明细表；届时再决定存差异还是存前后快照。
3. 结果区域在画布上的具体形态（固定区域、可移动分组还是侧栏），留给画布交互设计。

已决定（2026-10-26）：会话记录与 Claude 上下文的分工、崩溃后不自动重发、`new_node` 落点规则，见对应小节。
