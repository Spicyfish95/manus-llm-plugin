# dsh-manus-llm

将 Manus（[Manus API v2](https://open.manus.ai/docs/v2/introduction)）注册为 DeepSeek Harness 的模型提供方：输入 API Key 后，可在 DSH 的模型选择中以 `manus/standard`、`manus/lite`、`manus/max` 的身份对话——每轮对话由 Manus 云端代理执行，结果以流式文本返回。

## 工作方式

- **一轮 = 一个 Manus 任务**：会话首轮调用 `POST /v2/task.create` 创建任务，后续轮次通过 `task.sendMessage` 继续同一任务（任务 id 保存在助手消息的持久 replay state 中，跨重启可续聊）。
- **轮询转流式**：适配器轮询 `GET /v2/task.listMessages`，把新的 `assistant_message` 事件翻译成 Harness 的 `text-delta` 块；`status_update(stopped)` 结束回合。若整轮只有 `progress` 中间消息，则回放这些文本作为答案，而不是丢成空回复。
- **不支持工具调用**：Manus 有自己的内置工具；适配器声明无工具，工具结果按文本降级传递。
- **积分读数**：每轮开始/结束各读一次 `GET /v2/usage.availableCredits`，把余额差记为该轮消耗；对话工具栏（模型选择器旁）显示当前余额与「上轮消耗」，点开可看分项（赠送/周期/加购）。

## 三个档位与推理强度

| 模型 | Manus `agent_profile` | 说明 |
|---|---|---|
| `manus/standard` | `standard` | 标准代理档，速度与能力均衡 |
| `manus/lite` | `lite` | 轻量快速档，积分消耗更低 |
| `manus/max` | `max`（默认）/ `max-medium` / `max-high` / `max-extra` / `max-ultra` | 深度推理档；思考等级在模型选择器里选 |

只有 `max` 档带推理强度元数据，因此在模型选择器里选中 `Manus Max` 后会额外出现思考等级选项（默认 / 中 / 高 / 增强 / 极致）。所选等级的 id **就是** Manus 的 `agent_profile` 值，不需要再做映射；其余两档只有一个行为，不显示强度选项。

> Manus 文档注明：`max` 是默认 Max 思考等级（当前等价于 `max-extra`），免费个人账号会被降级到 `lite`。

## 配置

全部字段在「设置 → 模型」页（Manus 卡片）里可改，也可在 `cordis.patch.yml`（或 profile 的 patch 层）中覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKeyEnv` | `MANUS_API_KEY` | 凭证引用名；通过 Web Models 页或启动环境写入 |
| `defaultProfile` | `standard` | 未知模型 id 的回退档位（standard/lite/max） |
| `locale` | `zh-CN` | 任务输出语言 |
| `pollIntervalMs` | `2000` | 轮询间隔（毫秒） |
| `pollMaxSeconds` | `1200` | 单回合轮询上限，超时将 `task.stop` 并以 TIMEOUT 失败 |
| `requestTimeoutMs` | `60000` | 单次 HTTP 请求超时 |
| `contextWindow` / `maxTokens` | `1000000` / `32000` | 上报给 Harness 的模型能力（用于压缩与预算） |
| `trackCredits` | `true` | 是否记录每轮积分消耗（工具栏「上轮消耗」依赖它） |
| `showProgress` | `false` | 是否把 Manus 的 progress 中间消息并入输出 |
| `verboseEvents` | `false` | 轮询事件逐条写日志（调试用） |

## API Key 获取

1. 打开 [Manus Developers 设置](https://manus.im/app#settings/developers)。
2. **Create API Key**，复制（仅显示一次）。
3. 任选其一：
   - 「设置 → 模型」页选择 Manus 提供方并粘贴 Key（写入凭证存储，推荐）；或
   - 在 `$DSH_HOME/.env` 写入 `MANUS_API_KEY=...`；或
   - 启动环境导出 `MANUS_API_KEY`。

注意：Manus 按 credit 计费，max 系列档位消耗更高；费率见 Manus 文档的 Rate Limits。

## 浏览器端

`client.js` 在对话输入区注册两处积分读数（`conversation.input.left` 与 `conversation.composer.dock`），仅在当前模型是 `manus/*` 时出现。它只调用插件自己的只读路由 `/plugins/manus-llm/credits`（仅本机回环可访问），API Key 始终留在 Host 侧。
