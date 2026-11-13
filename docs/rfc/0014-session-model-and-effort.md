# 0014 · 会话级模型与思考强度

状态：已实现并验证（2026-10-29）

日期：2026-10-29

基于 [0005](0005-agent-adapters-and-mcp.md) 与 [0013](0013-agent-activity.md)。

## 背景

现在每个 Agent 都用固定的模型和默认思考强度：DeepSeek 写死 `deepseek-flash`，Codex 用它自己的默认模型；两者都不传思考强度（dsh 默认 `high`，Codex 用模型声明的默认值）。用户没法为一个难任务调高思考强度，也没法为一个简单任务换更快的模型。

两个 Agent 本身都支持（核对于 2026-10-29，本机 codex-cli 0.165.0、dsh 0.2.1-rc.2）：

| | 列出可选项 | 设置方式 |
|---|---|---|
| Codex | app-server `model/list`：每个模型有 `id`、`displayName`、`description`、`supportedReasoningEfforts[]`（`reasoningEffort` + `description`）、`defaultReasoningEffort`、`isDefault`、`hidden` | `turn/start` 的 `model` 与 `effort` |
| dsh | ACP `session/new` 返回的 `configOptions`：`id: 'model'`（`category: 'model'`，分组选项，值是不透明字符串）与 `id: 'reasoning_effort'`（`category: 'thought_level'`）。思考强度选项随当前模型变化 | ACP `session/set_config_option`，返回更新后的 `configOptions` |

范围（2026-10-29 与维护者确认）：只按会话设置，不做全局或按 Agent 的默认值；模型与思考强度一起做。

## 决定

### 契约

- `SessionSummary` 增加 `agentConfig: { model: string | null; effort: string | null }`。`null` 表示交给 Agent 默认，与现在的行为一致。升级前的幂等结果与事件没有这个字段，契约给它默认值 `{ model: null, effort: null }`，解析时补上，不改写旧记录。
- storage `sessions` 增加 `agent_model`、`reasoning_effort` 两个可空列（`db:generate` 生成 space 迁移）。
- 新方法（只允许 `ui` 调用；Agent 不能改自己的模型和强度）：

```ts
'session.agentOptions': {
  params: { sessionId }
  result: { models: AgentModelOption[] }
}
AgentModelOption = {
  id: string            // Codex 为模型 id；dsh 为 ACP 选项值（不透明）
  label: string
  description?: string
  isDefault: boolean    // Agent 的默认模型
  efforts: { id: string; label: string; description?: string }[]  // 可能为空：该模型不支持调节
  defaultEffort: string | null
}

'session.setAgentConfig': {
  params: { requestId, sessionId, model: string | null, effort: string | null }
  result: SessionSummary
}
```

- `setAgentConfig` 按 `requestId` 幂等；在 gateway / 会话服务里校验：`model` 非空时必须在 `agentOptions` 里；`effort` 非空时必须在所选模型（`model` 为空时取 Agent 默认模型）的 `efforts` 里。不合法返回 `invalid_params`。成功后发出会话变更事件，所有窗口刷新。
- 设置**从下一个回合开始生效**，进行中的回合不受影响；排队中尚未开始的消息按开始时刻的设置运行。

### 读取可选项

- 运行时端口增加 `agentOptions(agentKind, { model? })`。读取可选项**不调用模型**：Codex 启动 app-server 只发 `model/list`（隐藏模型不列出）；dsh 启动一个 ACP 进程、`session/new` 读 `configOptions`，再对每个模型 `set_config_option` 读出它的思考强度选项，然后结束这个探测会话。
- 结果按 Agent 种类缓存在 studiod 内存里 10 分钟；Agent 进程启动失败（未安装、未登录）时返回 `unavailable` 及原因，界面显示「无法读取模型列表」，并保留「默认」可选。
- 探测进程与正式会话使用相同的沙箱和配置覆盖，不读取任何凭据文件。

### 适配器生效方式

- **Codex**：`turn/start` 带上会话当前的 `model` 与 `effort`。Codex 会把这两项沿用到线程的后续回合，所以设为默认时不能不传：回合前用同一进程的 `model/list` 查出 Agent 默认模型及该模型的默认强度，显式传回；目录读不到时才不传。
- **dsh**：每个回合发出 prompt 前，比较会话设置与该 ACP 会话上次已生效的设置；不同就先 `session/set_config_option`（先模型后强度）。设置为空时设回 dsh 默认：模型回到配置覆盖里的 `deepseek-flash`，强度设为 ACP 选项中的「Provider default」（值为空字符串）或 dsh 默认 `high`。`set_config_option` 失败时本回合失败并在会话里写一条通知，不静默用旧设置运行。
- 恢复会话（`resume`）后照常按上述规则对齐。

### 界面

- 输入框工具行（「引用选中的节点」「Skill」旁）加一个按钮，显示当前选择，例如「默认」「gpt-5.5 · 高」「deepseek-pro · max」。点开为弹层：上面是模型列表（标出 Agent 默认），下面是该模型的思考强度；「默认」各一项。
- 切换模型时，原强度若不被新模型支持则重置为「默认」，并提示一句。
- 回合运行中可以改，改完在按钮旁显示「下一回合生效」直到下一回合开始。
- 可选项在第一次打开弹层时读取，读取中显示加载状态。

## 补充：速度档位（2026-10-30）

维护者 2026-10-30 提出模型设置里缺少 Codex 的 Fast 开关，原来列在「不做」里的 service tier 改为支持。

- **契约**：
  - `AgentModelOption` 增加 `serviceTiers`（`{ id, label, description? }[]`，不含标准速度，缺省为空）。
  - `agentConfig` 与 `session.setAgentConfig` 增加 `serviceTier`：`null` 表示跟随 Agent 自己的配置，`'default'` 表示强制标准速度，其余必须是所选模型声明过的档位，否则返回 `invalid_params`。
  - 旧记录和旧事件没有这个字段，解析时补成 `null`。数据库 `sessions` 加 `service_tier` 列。
- **Codex**：
  - 档位取自 `model/list` 的 `serviceTiers`；旧版只有已弃用的 `additionalSpeedTiers` 时退回使用它。
  - 回合用 `turn/start` 的 `serviceTierForTurn` 下发：只作用于这一回合，不改线程设置；`null` 时不传，沿用 Codex 配置。
- **dsh**：没有速度档位，`serviceTiers` 为空。
- **界面**：
  - 所选模型有档位（或已设了速度）时，模型设置里出现「速度」：默认 / 标准 / 各档位。选中档位后显示该档位的说明（例如会消耗更多额度），按钮文字带上档位名。
  - 换到不支持原档位的模型时恢复默认，并提示「此模型不支持原速度，已恢复默认。」
  - 回合中修改同样显示「下一回合生效」。

## 不做

- 全局或按 Agent 种类的默认模型 / 强度。
- Codex 的 personality 等其他参数。
- 让 Agent 自己调整模型或强度。
  Revised by [RFC 0049](0049-child-agent-model.md): Agents may configure direct child sessions on author direction; their own session stays UI-only.

## 验收

- `pnpm check` 通过；`pnpm build` 后完整 e2e 连续两轮通过。
- 单元测试：`setAgentConfig` 校验（未知模型、模型不支持的强度、`null` 默认）与幂等；Codex `model/list` 转换（隐藏模型过滤、默认标记）与 `turn/start` 带参；dsh `configOptions` 解析、按模型探测强度、回合前只在变化时 `set_config_option`、失败写通知；可选项缓存与 `unavailable`。
- e2e（fake Codex 响应 `model/list` 并记录 `turn/start` 参数）：选择模型与强度后发消息，请求里带上对应 `model` / `effort`；切到不支持原强度的模型时重置为默认；回合中修改显示「下一回合生效」。
- 两份 README（中英）与路线图更新；0005 补模型与强度对照。
- 真实 Codex / dsh 下的效果验证需要维护者批准。
