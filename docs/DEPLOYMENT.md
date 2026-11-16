# 安装、部署与数据

## 选一台机器作为工作台

本版面向一个可信用户及其 AI。一个服务保存一份数据，所有浏览器和 MCP 客户端连接它。它没有多租户账号、团队权限或公网 OAuth 流程，不应被描述成已完成的多人 SaaS。

- **已有 Codex/Kimi 的电脑**：最短路径。CLI 与服务使用同一系统用户；先跑通真实稿件和导出。
- **Lab 常驻服务**：适合多设备访问。Lab 上运行 Node；若使用内部 CLI 引擎，还需在 Lab 登录官方 CLI。Mac 浏览器里的登录状态不会自动出现在 Lab。
- **只使用外部 AI + MCP**：Lab 不需要安装任何模型 CLI。外部 AI 自己完成创作，再通过 MCP 写回。

截至本版本，代码和自动化验证已提供；没有替用户的 Mac/Lab 安装常驻服务或登录模型账号。

## 安装与配置

```sh
git clone https://github.com/q652983601/media-desk-mcp.git
cd media-desk-mcp
npm ci
npm run build
cp .env.example .env
npm start
```

`standalone/cli.mjs` 从仓库根目录加载 `.env`，已有进程环境变量优先。MCP stdio 入口不加载此文件，需由 MCP 客户端显式注入连接地址和 token。

| 变量 | 默认值 / 作用 |
| --- | --- |
| `MEDIA_DESK_HOST` | `127.0.0.1` |
| `MEDIA_DESK_PORT` | `4319` |
| `MEDIA_DESK_DATA_DIR` | `~/.local/share/morandi-media-desk` |
| `MEDIA_DESK_TOKEN` | 本机默认未设置；非 loopback 监听必须设置 |
| `MEDIA_DESK_ALLOWED_HOSTS` | 允许访问的外部 Host，逗号分隔，包含实际端口（若有） |
| `MEDIA_DESK_PUBLIC_URL` | MCP 返回给用户的界面/图片链接 origin，远程部署时必须配置可访问地址 |
| `MEDIA_DESK_ENABLE_MONID` | 默认关闭；值为 `1` 才允许账号作品导入 |

CLI 引擎配置见 [ARCHITECTURE.md](ARCHITECTURE.md)，MCP 客户端配置见 [MCP.md](MCP.md)。不会自动安装模型 CLI 或创建账户。

## Lab / HTTPS 入口

独立服务以 `0.0.0.0` 监听，内部 MCP 请求仍访问 loopback。外部由现有的 HTTPS 反向代理转发；例如配置：

```dotenv
MEDIA_DESK_HOST=0.0.0.0
MEDIA_DESK_PORT=4319
MEDIA_DESK_DATA_DIR=/absolute/path/to/private/media-desk-data
MEDIA_DESK_TOKEN=REPLACE_WITH_LONG_PRIVATE_TOKEN
MEDIA_DESK_ALLOWED_HOSTS=desk.example.com
MEDIA_DESK_PUBLIC_URL=https://desk.example.com
```

`desk.example.com` 是占位符，不是已部署地址。HTTPS 入口应保留请求 Host 和 Authorization，将 `/`、`/media-desk/*`、`/session`、`/mcp` 转发到该服务，并支持长请求。不要把服务挂到额外的子路径下；当前 UI 和 origin 配置按域名根路径工作。4319 应只对代理或可信网络开放。

不推荐绑定特定私网 IP 后让内部代理携带 token 经明文 HTTP 访问那个 IP；当前 MCP 客户端会拒绝这种远程明文凭据用法。上述 `0.0.0.0 + 内部 loopback + 外部 HTTPS` 配置无需放宽保护。

首次打开网页时输入工作台访问密钥。浏览器得到 HttpOnly、SameSite=Strict 的会话 cookie；MCP 使用 bearer header。更换 token 后，旧会话与旧 MCP token 失效。这个单用户 token 不提供不同 AI 之间的细粒度权限分组。

使用现有进程管理器保持 `node /ABSOLUTE/PATH/TO/media-desk-mcp/standalone/cli.mjs` 运行即可。不需要再加数据库、消息队列或单独的 MCP 守护进程。健康检查为 `GET /healthz`，正常返回 `ok: true`。

## 内容、导出与备份

数据目录包括 `state.json`、`settings.json`、`files/` 以及服务锁信息。模型 CLI 的登录凭据仍由对应 CLI 管理，不在工作台数据目录中。图片 API key（如配置）由原设置实现保存在私有 `settings.json` 中，因此备份也应视为私密数据。

备份时优先停止服务，备份完整数据目录，再启动。恢复到新机器前，确认旧实例已停止，使用独立目录恢复，并清除备份里旧机器的 `.server-locks` 目录后启动；不要在原机器仍运行时删除它的锁。代码目录、数据目录、导出目录分别管理。

原导出功能默认写入服务用户的 `Documents/自媒体工作台`（英文界面可为 `Documents/Media Desk`），也可以在原设置中指定目录。Lab 上导出的是 Lab 的文件夹；客户端不会自动下载。远程文件分发可接现有共享目录，当前版本没有增加下载打包接口。

## 从原 DSH 版本迁移

当前版仍使用原 state 数据结构，但真实个人数据迁移尚未验收。保守做法是：先停止原写入进程，备份其 `media-desk` 内容目录，将 `state.json`、`settings.json`、`files/` 复制到一个新的独立数据目录，再以 `MEDIA_DESK_DATA_DIR` 指向新目录启动验证。不要让 DSH 与独立版同时写同一份目录。

模型选择可能保留了旧 DSH provider，应在独立版重新选择已配置的 Codex/Kimi/API；DSH 订阅生图工具在独立版不可用。导出记录里的旧绝对路径也不会自动迁移到新机器，需要按实际文件位置检查。此过程不修改原备份。

## 升级

停止服务，备份数据，更新代码后重新运行 `npm ci && npm run build`，再启动。升级前可运行 `npm run verify:frontend` 和 `npm test`。独立版本不再使用上游 DSH 插件市场更新提示，不会自动替换原前端文件。
