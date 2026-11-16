# 独立架构与执行引擎

## 目标与取舍

保留 `dsh-media-desk` 的原前端和内容工作流，把其宿主接口替换为小型独立运行层。浏览器是人的入口，MCP 是 AI 的入口；两者访问同一份内容。对一人和 AI 的工作方式，先提供可安装、可备份的一个服务，比拆成数个微服务更直接。

不是把网页按钮包装成自动点击，也不要求用户购买特定模型 API。外部 AI 可使用自己的模型完成创作，只把结果写回工作台；内部助手是另一种可选入口。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `client/`、`assets/` | 固定在上游 2.7.2 的原前端和素材，不修改 |
| `standalone/client.jsx`、`theme/` | 提供最小宿主插槽适配、原主题 CSS 与外部状态同步 |
| `standalone/server.mjs`、`runtime.mjs` | HTTP 服务、认证、同源校验、单数据目录锁、生命周期 |
| `src/host.js`、`store.js`、`produce.js` 等 | 原内容领域逻辑和 API，增加必要的独立运行与并发修复 |
| `standalone/mcp-tools.mjs` | 与宿主无关的 MCP tools/resources，内部通过工作台 HTTP API 操作 |
| `standalone/mcp.mjs`、`mcp-http.mjs` | stdio 代理和 Streamable HTTP 传输 |
| `standalone/production-import.mjs` | 外部完整稿件与图片挂载、内容版本检查 |
| `standalone/model.mjs` | 让原模型选择器使用显式配置的模型，不静默切换提供方 |
| `standalone/agents.mjs`、`agent-protocol.mjs` | CLI 运行定义和共用子进程协议层 |

一个服务实例拥有一个 Store 和 Producer，其他入口不直接改数据文件。目录锁防止两个服务写同一目录；Store/Settings 的写队列避免异步覆盖。整篇生成与单图重画交叉互斥，关闭服务时取消任务、等待队列后释放锁。

完整稿件和附件写入支持 `expectedRevision`：调用者先读取 production 内容版本，再提交替换或挂载；若有更新，拒绝旧版本覆盖。原前端的普通字段修改仍是上游 patch 接口，因此不能把这描述为所有操作都有全局事务或版本控制。

## 从 OpenDesign 借鉴什么

参考 [OpenDesign](https://github.com/nexu-io/open-design/tree/84dd08b5709bfa4bf4108ece8424d15e4062c982) 及其 [agent adapters 文档](https://github.com/nexu-io/open-design/blob/84dd08b5709bfa4bf4108ece8424d15e4062c982/docs/agent-adapters.md)：

1. **外部接入和内部执行分开。** MCP 暴露工作台能力，CLI adapter 执行模型任务；它们互不要求对方存在。
2. **复用官方 agent runtime。** 登录、模型使用权和 agent 协议由官方 CLI 管理。工作台不保存一套自制的会员凭据。
3. **运行定义小，协议实现集中。** 每个 provider 声明命令、型号和协议；取消、超时、输入输出限制复用。
4. **内容由工作台持有。** 换 AI 客户端或换内部引擎不影响已保存稿件和素材。

没有复制 OpenDesign 的运行时源码，也没有引入它的完整项目环境、设计工具或工程调度功能。本项目仍以原自媒体工作流为边界。

## Codex adapter

启动参数：

```text
codex exec --json --ephemeral --sandbox read-only
  --skip-git-repo-check --ignore-user-config -c approval_policy="never"
```

具体型号通过 `--model` 指定；提示词通过 stdin 传入，不拼接 shell。仅在完整回合成功、进程成功退出并取得最终 agent message 后返回正文。中间事件不当作正文，失败或协议损坏不会返回半篇成功结果。

开发环境只核验了 `codex-cli 0.167.0-alpha.4` 的 `--version` / `exec --help`；未调用真实模型。部署版本必须支持这些非交互参数，若不支持则报错，不移除约束后重试。

## Kimi adapter

使用 `kimi acp`，顺序为 `initialize → session/new → session/set_mode(default) → 可选 session/set_model → session/prompt`。只接收当前 session 的正文片段；以 `stopReason: end_turn` 判定完成，失败退出或截断返回错误。

当前核验基线为 [MoonshotAI/kimi-code @ 6e35efa](https://github.com/MoonshotAI/kimi-code/tree/6e35efa98402b2a5a198aa929ef178e79ab26bb4)。依据其 [CLI 命令](https://github.com/MoonshotAI/kimi-code/blob/6e35efa98402b2a5a198aa929ef178e79ab26bb4/docs/en/reference/kimi-command.md)、[ACP 协议](https://github.com/MoonshotAI/kimi-code/blob/6e35efa98402b2a5a198aa929ef178e79ab26bb4/docs/en/reference/kimi-acp.md) 和 [模式映射](https://github.com/MoonshotAI/kimi-code/blob/6e35efa98402b2a5a198aa929ef178e79ab26bb4/packages/acp-server/src/modes.ts)，显式设置 default/manual 模式。权限请求被取消，文件/终端等 reverse RPC 被拒绝。不使用 auto、yolo 或静默 API 回退。

**ACP 权限处理不是完整操作系统隔离。** 官方实现仍有部分本地文件/进程路径，临时 cwd 与拒绝 host RPC 不意味着绝对无法读取目录外文件。如将来需要执行不可信任务，须另配系统级隔离。目前只实现协议适配并以假 CLI 验证；真实 Kimi 安装、登录和输出尚未验收。

## 共用进程行为

- `spawn` 使用 `shell: false`；输入按字面量传入。
- 每次任务创建临时工作目录并清理，复用 CLI 原有用户 HOME 和官方登录位置。
- 环境变量采用允许列表，不把服务中无关 API key 或 Git token 传给子进程。
- 每个 provider 同时最多一个任务，不自动重试；取消和超时会结束进程组。
- 输入最多 256 KiB；stdout 与 stderr 合计默认 2 MiB；默认超时 180 秒。
- 输出日志不回传原始 stderr 或凭据。CLI 的 `maxTokens` 只是文本长度提示，不能当作提供方计费或 token 硬限制。

配置项：

| 配置 | 默认 / 含义 |
| --- | --- |
| `MEDIA_DESK_AGENTS` | 空；用 `codex,kimi` 显式启用 |
| `MEDIA_DESK_CODEX_COMMAND` / `MEDIA_DESK_KIMI_COMMAND` | 从 PATH 查找 `codex` / `kimi` |
| `MEDIA_DESK_CODEX_MODELS` / `MEDIA_DESK_KIMI_MODELS` | `default`；多个型号逗号分隔，按账号实际可用填写 |
| `MEDIA_DESK_AGENT_WORKDIR` | 系统临时目录；每次在其下创建新的任务子目录 |
| `MEDIA_DESK_AGENT_TIMEOUT_MS` | `180000`；允许 100–600000 ms |
| `MEDIA_DESK_AGENT_MAX_OUTPUT_BYTES` | `2097152` |

## 为什么暂不做 MCP Apps 嵌入

原完整工作台通过自己的网页提供。普通 MCP 客户端对交互 UI 的支持不一致，把所有界面绑定到某一种宿主会削弱通用性。之后可以单独为支持 MCP Apps 的客户端提供预览卡片；不需要因此重写当前原版前端或让协议依赖某一家 AI 产品。


## CLI 网页配置增量

「设置」内的 CLI 工具配置支持 Codex、Claude Code、Kimi、MiniMax mmx。`standalone/cli-settings.mjs` 管理数据目录中的 `cli.json`，使用 expectedRevision 拒绝过期覆盖，以临时文件和 rename 保存。环境变量只提供首次配置，网页保存后优先使用持久配置。启用状态、命令路径和模型列表会立即刷新原模型选择器。CLI 生成期间拒绝配置变更，已准备的旧配置会在生成入口核对版本。

- `GET /media-desk/cli` 返回当前版本、四种 CLI 配置及安装检测结果。
- `POST /media-desk/cli` 接受 expectedRevision 和完整 providers 数组，保存并立即应用。
- `POST /media-desk/cli/detect` 检测提交的命令路径，返回安装状态。

上述接口沿用服务的 Host、Origin 和认证检查。可执行文件作为单个 spawn 路径使用，启动参数由对应适配器固定。界面检测检查文件存在性与可执行权限，账号状态显示待验证。关闭或移除当前模型时，助手选择恢复为服务默认值。

Claude Code 在本机 2.1.322 的帮助中核对了 print JSON、safe-mode、tools、strict-mcp-config 和 no-session-persistence 参数。输入通过 stdin，禁用内置工具并传入空 MCP 配置，成功的 result/success 才作为正文。MiniMax 基于本机 mmx 1.0.7 的 text chat 协议，使用 messages-file 的 stdin 输入，接收完整 Messages API JSON 并提取 text 内容块，stop_reason 必须为 end_turn。mmx 的 quiet 会输出纯文本，因此结构化适配使用 output=json 和 non-interactive。模型 default 由对应 CLI 自行解析。

Claude 和 MiniMax 的提供方凭据环境变量分别只传给对应子进程。其余进程行为沿用共用适配层。实际账号和模型输出验收单独记录。
