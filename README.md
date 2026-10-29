# @local/manus-llm

将 Manus（[Manus API v2](https://open.manus.ai/docs/v2/introduction)）注册为 DeepSeek Harness 的模型提供方：输入 API Key 后，可在 DSH 的模型选择中以 `manus/*`（如 `manus/standard`、`manus/max`）的身份对话——每轮对话由 Manus 云端代理执行，结果以流式文本返回。

## 工作方式

- **一轮 = 一个 Manus 任务**：会话首轮调用 `POST /v2/task.create` 创建任务，后续轮次通过 `task.sendMessage` 继续同一任务（任务 id 保存在助手消息的持久 replay state 中，跨重启可续聊）。
- **轮询转流式**：适配器轮询 `GET /v2/task.listMessages`，把新的 `assistant_message` 事件翻译成 Harness 的 `text-delta` 块；`status_update(stopped)` 结束回合。
- **模型 = 代理档位**：`standard / lite / max / max-medium / max-high / max-extra / max-ultra`。
- **不支持工具调用**：Manus 有自己的内置工具；适配器声明无工具，工具结果按文本降级传递。

## 配置

在 `cordis.patch.yml`（或 profile 的 patch 层）中覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKeyEnv` | `MANUS_API_KEY` | 凭证引用名；通过 Web Models 页或启动环境写入 |
| `defaultProfile` | `standard` | 未知模型 id 的回退档位 |
| `locale` | `zh-CN` | 任务输出语言 |
| `pollIntervalMs` | `2000` | 轮询间隔 |
| `pollMaxSeconds` | `1200` | 单回合轮询上限，超时将 `task.stop` 并以 TIMEOUT 失败 |
| `contextWindow` / `maxTokens` | `1000000` / `32000` | 上报给 Harness 的模型能力（用于压缩与预算） |
| `showProgress` | `false` | 是否把 Manus 的 progress 消息并入输出 |

## API Key 获取

1. 打开 [Manus Developers 设置](https://manus.im/app#settings/developers)。
2. **Create API Key**，复制（仅显示一次）。
3. 任选其一：
   - Web Models 页选择 Manus 提供方并按提示存储；或
   - 在 `$DSH_HOME/.env` 写入 `MANUS_API_KEY=...`；或
   - 启动环境导出 `MANUS_API_KEY`。

注意：Manus 按 credit 计费，max 系列档位消耗更高；费率见 Manus 文档的 Rate Limits。
