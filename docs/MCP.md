# Media Desk MCP 接入与写回指南

本指南对应 `media-desk-mcp` 0.1.0 的实际接口。项目源码位置：[`q652983601/media-desk-mcp`](https://github.com/q652983601/media-desk-mcp)。接口定义以 [`standalone/mcp-tools.mjs`](../standalone/mcp-tools.mjs) 和 [`standalone/production-import.mjs`](../standalone/production-import.mjs) 为准。

工作台保留原来的网页界面，MCP 让不同 AI 操作同一份灵感、稿件、图片、排期和表现数据。MCP 提供的是工具与数据接口；`media_desk_open` 返回工作台网址，客户端是否把网页嵌入对话取决于该客户端。

## 1. 两条使用路径

| 路径 | 谁负责创作 | 工作台负责什么 | 适合的情况 |
| --- | --- | --- | --- |
| 外部 AI 自己创作，再通过 MCP 写回 | 已在使用的 Codex、Kimi 或其他 MCP 客户端中的 AI | 保存文章、脚本、分镜与图片，供原界面编辑、排期、复盘和导出 | 默认推荐；直接使用当前 AI 的上下文和能力 |
| 工作台调用已配置的生成引擎 | 服务所在机器启用的 CLI Agent，或明确配置的兼容 API | 执行生成流水线，保存进度与结果 | 希望直接在工作台点“一键成稿”，或由 MCP 启动后台生成 |

第一条路径使用 `write_production`、`upload_asset`、`attach_asset`，这些工具不会再次调用文字或图片模型。AI 本身的使用成本由其所在客户端决定。

第二条路径使用 `generation_start`，也可直接操作网页中的生成按钮。安装 MCP 客户端不等于为工作台配置了生成引擎；登录一个聊天应用也不等于服务进程已取得它的 CLI 或生图能力。未配置可用模型时，原流水线会显式降级为结构草稿，不能把这种结果当作真实模型生成的成品。

## 2. 先运行唯一的数据服务

在已经安装依赖、构建前端的项目目录启动服务：

```bash
cd /ABSOLUTE/PATH/TO/media-desk-mcp
npm ci
npm run build
npm start
```

默认网页为 `http://127.0.0.1:4319/`，默认 MCP HTTP 端点为 `http://127.0.0.1:4319/mcp`。将上面的绝对路径替换成实际项目路径；这里不是已发布 npm 包的安装命令。

网页、stdio MCP 和 HTTP MCP 都连接这个常驻服务。**多个 AI 可以各启动自己的 stdio MCP 进程，但不要为同一数据目录启动多个数据服务。** stdio 进程只代理 HTTP，不直接打开 `state.json`。数据服务会拒绝第二个活跃进程占用同一数据目录。

数据目录默认是 `~/.local/share/morandi-media-desk`，可通过服务进程的 `MEDIA_DESK_DATA_DIR` 指定。这里保存的是工作台内容，不要求安装或启动 DSH。

## 3. 配置 MCP 客户端

### 3.1 stdio：本机客户端连接常驻服务

支持 `mcpServers` 配置格式的客户端可以使用下面的配置。把两个绝对路径替换成实际的 Node 可执行文件和项目位置：

```json
{
  "mcpServers": {
    "media-desk": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": [
        "/ABSOLUTE/PATH/TO/media-desk-mcp/standalone/mcp.mjs"
      ],
      "env": {
        "MEDIA_DESK_URL": "http://127.0.0.1:4319"
      }
    }
  }
}
```

客户端采用 TOML、图形设置或其他配置格式时，填写同一组命令、参数与环境变量。不要把 `npm start` 当成 stdio MCP 命令：它启动的是数据服务。stdio MCP 入口是 `standalone/mcp.mjs`。

如需让 Mac 上的 AI 通过 stdio 连接 Lab 上的工作台，可把上述 `env` 改为：

```json
{
  "MEDIA_DESK_URL": "https://YOUR_PRIVATE_DESK_HOST",
  "MEDIA_DESK_PUBLIC_URL": "https://YOUR_PRIVATE_DESK_HOST",
  "MEDIA_DESK_TOKEN": "REPLACE_WITH_PRIVATE_ACCESS_TOKEN",
  "MEDIA_DESK_IMPORT_ROOTS": "/ABSOLUTE/PATH/TO/agent-artifacts"
}
```

`MEDIA_DESK_URL` 只填写 origin，不带 `/mcp`、`/media-desk`、query、用户名或密码。stdio 适配器在内部调用数据服务的业务 HTTP 接口。远程 bearer 凭据默认要求 HTTPS；本机 loopback 允许 HTTP。真实访问密钥应通过客户端的私密配置或密钥管理方式注入，不放进项目提交。

### 3.2 Streamable HTTP：直接连接服务的 `/mcp`

支持 Streamable HTTP 的客户端填写：

| 配置项 | 本机无 token 服务 | 已配置 HTTPS 与 token 的远程服务 |
| --- | --- | --- |
| Transport | Streamable HTTP | Streamable HTTP |
| URL | `http://127.0.0.1:4319/mcp` | `https://YOUR_PRIVATE_DESK_HOST/mcp` |
| HTTP Header | 无需额外 header | `Authorization: Bearer REPLACE_WITH_PRIVATE_ACCESS_TOKEN` |

远程监听推荐由服务使用 `MEDIA_DESK_HOST=0.0.0.0`，同时配置 `MEDIA_DESK_TOKEN`，再由私有 HTTPS 入口转发。`MEDIA_DESK_ALLOWED_HOSTS` 必须包含实际入口的 Host，例如 `desk.example.com`；`MEDIA_DESK_PUBLIC_URL=https://desk.example.com` 用于返回用户可打开的网址。内部 MCP 代理仍使用 loopback 访问同一服务。

这是 bearer token 接入，不会自动提供 OAuth 登录流程。客户端需要支持自定义鉴权 header，或使用前述 stdio 适配器。浏览器的工作台登录 cookie 也不等于其他机器上的 MCP 客户端已获得访问权限。

以下是本项目使用的官方 TypeScript SDK 接法，可在已安装本项目依赖的 Node ESM 文件中使用：

```js
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const client = new Client({ name: 'my-media-agent', version: '1.0.0' })
const transport = new StreamableHTTPClientTransport(
  new URL('https://YOUR_PRIVATE_DESK_HOST/mcp'),
  {
    requestInit: {
      headers: { authorization: `Bearer ${process.env.MEDIA_DESK_TOKEN}` },
    },
  },
)

await client.connect(transport)
try {
  const tools = await client.listTools()
  const opened = await client.callTool({ name: 'media_desk_open', arguments: {} })
  console.log(tools.tools.map(tool => tool.name), opened)
} finally {
  await client.close()
}
```

## 4. 17 个工具

下表列出实际工具名。可选字段、长度限制和枚举值以客户端的 `tools/list` 结果为准。成功结果同时提供 JSON 文本 `content` 和 `structuredContent`；业务失败使用 `isError: true` 与错误说明。调用方必须检查 `isError`，不能只看是否收到了 MCP 响应。

| 工具 | 主要参数 | 行为 |
| --- | --- | --- |
| `media_desk_open` | `{}` | 检查服务并返回原工作台网址、条目数量及模型状态。 |
| `media_desk_list_items` | `query?`、`status?`、`platform?`、`includeSamples?`、`limit?`、`offset?` | 搜索灵感和内容摘要；默认 30 条，最多 100 条，返回 `nextOffset`。 |
| `media_desk_get_item` | `id` | 读取完整条目、稿件、当前写作风格和有效规则；另返回 `productionRevision`。 |
| `media_desk_save_idea` | `id?`、`title?`、`body?`、`kind?`、`tags?`、`url?`、`platform?` | 不带 `id` 新增，带 `id` 更新；新增必须有标题或正文。 |
| `media_desk_schedule` | `id`、`scheduledAt`、`platform?` | 设置排期；`scheduledAt: null` 取消排期。 |
| `media_desk_set_status` | `id`、`status` | 修改内容状态。 |
| `media_desk_record_metrics` | `platform`、`date`、`itemId?`、`views?`、`likes?`、`comments?`、`shares?`、`saves?` | 追加一次真实表现数据观察；重复调用会再增加一条。 |
| `media_desk_style` | `action: list\|save\|select`、`id?`、风格字段 | 列出、保存或选择风格；`select` 配 `id: null` 清除当前选择。 |
| `media_desk_rules` | `action: list\|save\|learn\|export`、`id?`、`name?`、`rule?` 等 | 管理规则、从现有指标提出规则，或导出规则 Skill；不会替 Agent 安装 Skill。 |
| `media_desk_generation_start` | `id`、`withImages?`、`costApproved: true` | 启动服务端已配置的生成流水线，立即返回；图片默认关闭。 |
| `media_desk_generation_status` | `id` | 读取 `production`、内容 `status`、`live` 进度与 `revision`。 |
| `media_desk_generation_cancel` | `id` | 请求取消该条目的整篇生成；请求成功不代表此前的模型消耗会退回。 |
| `media_desk_write_production` | `id`、`production`、`expectedRevision?`、`author?` | 将外部 AI 已经写好的完整稿面保存到原界面。 |
| `media_desk_upload_asset` | `filePath` 或 `base64`，二选一 | 导入外部图片，返回可用于稿面的 `src`。 |
| `media_desk_attach_asset` | `id`、`target`、`src`、`expectedRevision?` | 将现有工作台图片挂到封面、配图或分镜。 |
| `media_desk_export_production` | `id` | 将稿件及本地媒体保存到服务机器的导出目录。 |
| `media_desk_insights` | `{}` | 读取现有表现数据的统计与分析。 |

内容状态枚举：`idea`、`outline`、`draft`、`ready`、`published`。灵感类型枚举：`image`、`video`、`web`、`quote`、`note`。

平台枚举：`公众号`、`小红书`、`抖音`、`B站`、`视频号`、`TikTok`、`Instagram`、`YouTube`、`X`。时间应包含明确时区，例如 `2026-11-20T20:00:00+08:00`。

`style` 的写入字段包括 `name`、`summary`、`tone`、`sentences`、`opening`、`structure`、`logic`、`story`、`flow`、`words`、`avoid`、`samples`。`rules` 的写入字段包括 `name`、`rule`、`source`、`evidence`、`status`；规则状态为 `proposed`、`active` 或 `exported`。

## 5. 3 个资源

资源 MIME 类型均为 `application/json`，可通过 MCP `resources/read` 获取。

| URI | 内容 |
| --- | --- |
| `media-desk://board` | 工作台网址、条目总数及前 100 条摘要。需要分页或搜索时使用 `list_items`。 |
| `media-desk://writing-context` | 当前选定风格、创作体裁和 `active`／`exported` 规则。 |
| `media-desk://insights` | 当前表现数据分析。 |

例如官方 SDK：

```js
const context = await client.readResource({ uri: 'media-desk://writing-context' })
const writingContext = JSON.parse(context.contents[0].text)
```

## 6. 外部 AI 完整写回示例

以下 JSON 是传给 `client.callTool(...)` 的 `{ name, arguments }`，不是包含 `jsonrpc`、请求 `id` 和 `method` 的完整协议报文。尖括号中的字符串都是占位符，必须替换为上一步返回的真实值。

### 第一步：记录灵感

```json
{
  "name": "media_desk_save_idea",
  "arguments": {
    "title": "AI 能做得更多之后，我想把时间花在哪里",
    "body": "从今天的一次实际选择出发，写一篇第一人称思考长文。",
    "kind": "note",
    "platform": "X",
    "tags": ["AI", "个人成长"]
  }
}
```

从成功结果的 `structuredContent.item.id` 取出条目 ID。写作前读取该条目与规则：

```json
{
  "name": "media_desk_get_item",
  "arguments": { "id": "<ITEM_ID>" }
}
```

结果中 `item` 是内容，`activeStyle` 和 `rules` 是写作依据，`productionRevision` 是当前稿件版本。条目尚无任何稿件时，这个版本才是 `null`。**不要因为稿件不是自己写的，就把版本当作 `null`。**

### 第二步：AI 自己创作，保存完整稿面

下面用短正文展示结构；实际调用应传入完整正文。如果上一步返回 `productionRevision: null`，首次写入可以这样调用：

```json
{
  "name": "media_desk_write_production",
  "arguments": {
    "id": "<ITEM_ID>",
    "author": "Codex",
    "expectedRevision": null,
    "production": {
      "title": "工具变多以后，我开始认真选择自己的问题",
      "format": "article",
      "article": "今天，我又让 AI 帮我完成了一件以前不会做的事。\n\n## 一次具体的选择\n\n能力的增加，让我重新思考时间应当花在哪里。",
      "coverText": "我想把时间花在哪里",
      "cover": {
        "prompt": "A quiet desk beside a window, handwritten notes and soft morning light"
      },
      "outline": ["一次具体的选择", "工具与自己的问题"],
      "images": [
        {
          "caption": "桌面上仍未收好的手写笔记",
          "anchor": "一次具体的选择",
          "prompt": "Close-up of handwritten notes on a quiet wooden desk"
        }
      ],
      "shots": [
        {
          "shot": "近景",
          "visual": "窗边桌面，手写笔记被轻轻翻开。",
          "voice": "今天，我又让 AI 完成了一件以前不会做的事。",
          "seconds": 5,
          "prompt": "Black and white storyboard, close-up of a hand opening a notebook"
        }
      ]
    }
  }
}
```

成功返回 `id`、`production`、`revision` 和内容 `status`。保留此处的新 `revision`，后续修改或挂图使用它。`author` 用于标记来源，不能用它推断该 Agent 的真实账号身份已经验证。

`write_production` 是**完整稿面替换**。如果覆盖已有稿件，必须将打算保留的封面、配图和分镜一起传入；省略的 `images`、`shots` 会成为空数组。输入接受 `title`、`article`、`format`、`coverText`、`cover`、`facts`、`outline`、`characters`、`images`、`shots`，不接受响应中的 `status`、`stage`、`engine`、`savedPath` 等服务端字段，因此不能把读取到的 `production` 对象不经筛选直接原样写回。

目前输入限制为：标题最多 200 字符、正文最多 200,000 字符、封面文案最多 40 字符、配图最多 8 张、分镜最多 24 镜。`format` 可用 `article` 或 `script`，默认 `article`。每镜时长在 1～60 秒之间，分镜编号由服务按数组顺序重新生成。

上面只写入了图片提示词，还没有生成图片。无 `src` 的图片会被标记为未附图；工作台不会因此自动调用生图服务。

### 第三步：上传外部生成的图片

本地路径方式：

```json
{
  "name": "media_desk_upload_asset",
  "arguments": {
    "filePath": "/ABSOLUTE/PATH/TO/agent-artifacts/cover.png"
  }
}
```

该路径必须位于运行 MCP 进程时配置的 `MEDIA_DESK_IMPORT_ROOTS` 中。macOS／Linux 多目录用 `:` 分隔，Windows 用 `;` 分隔，均填写实际绝对路径。未配置目录时，本地路径读取被禁用；符号链接解析后也必须仍在允许目录中。

Base64 方式：

```json
{
  "name": "media_desk_upload_asset",
  "arguments": {
    "base64": "<IMAGE_BASE64_BYTES>"
  }
}
```

只传图片字节的标准 Base64 字符串，不加 `data:image/png;base64,` 前缀。两种方式只能选一种。接受 PNG、JPEG、GIF、WebP，图片原始字节最多 20 MiB；客户端自身也可能有更小的请求体限制。

| 接入方式 | `filePath` 指向哪里 |
| --- | --- |
| Mac 上的 stdio MCP 代理连接本机或远程服务 | Mac 上该 MCP 代理进程可读取的允许目录；它会把图片字节上传给数据服务。 |
| 直接使用远程 `/mcp` | 远程服务机器的允许目录；它看不到调用者电脑上的文件。 |
| 云端 AI 没有共享文件系统 | 使用 Base64 图片字节，或先将图片放到相应允许目录；不能把聊天附件 URL 当成 `filePath`。 |

成功结果中的 `src` 形如 `media-desk/files/f_....png`，还会返回 `bytes`、`mimeType`、`url` 和媒体 `kind`。下一步使用真实返回的 `src`。工具不支持任意远程 URL 下载。

### 第四步：把图片挂入稿面

```json
{
  "name": "media_desk_attach_asset",
  "arguments": {
    "id": "<ITEM_ID>",
    "target": "cover",
    "src": "<SRC_RETURNED_BY_UPLOAD>",
    "expectedRevision": "<REVISION_RETURNED_BY_WRITE_PRODUCTION>"
  }
}
```

`target` 可用 `cover`、`image:0`～`image:7`、`shot:0`～`shot:23`。配图与分镜索引从 **0** 开始，对应稿面数组里的实际位置；先写入规划，再挂入相应图片，不能挂到尚不存在的配图或分镜槽位。

上传图片本身不会改变稿件版本；挂图成功后会返回新的 `revision`。连续挂第二张图片时，使用上一次挂图返回的版本，或重新调用 `get_item` 取得 `productionRevision`。

### 第五步：修改、排期与导出

修改完整稿件前重新读取 `get_item`，将其 `productionRevision` 原样传为 `expectedRevision`。发生冲突时，HTTP 业务路由返回 409，MCP 返回 `isError: true` 和冲突说明；重新读取当前稿件、整合差异后再提交，不要直接重试旧内容。省略 `expectedRevision` 会跳过版本检查，只应用于已经明确决定完整覆盖的操作。

这个检查覆盖外部完整稿件与附件写入。原前端其他字段补丁和普通灵感修改并没有全部升级为同样的版本协议，不能把它理解为全系统的版本控制。

排期示例：

```json
{
  "name": "media_desk_schedule",
  "arguments": {
    "id": "<ITEM_ID>",
    "scheduledAt": "2026-11-20T20:00:00+08:00",
    "platform": "X"
  }
}
```

导出示例：

```json
{
  "name": "media_desk_export_production",
  "arguments": { "id": "<ITEM_ID>" }
}
```

导出结果包含服务机器上的 `path`、文件清单及 `pathLocation: "server"`。它不会自动将文件下载到 MCP 客户端电脑。导出目录由工作台设置决定；规则 `export` 则生成独立数据目录内的 Skill 文件，不会自动安装到 Codex 或 Kimi。

## 7. 可选：由工作台内部启动生成

服务可以启用已经安装的 CLI 引擎，例如 `MEDIA_DESK_AGENTS=codex,kimi`，或配置 `MEDIA_DESK_BASE_URL`、`MEDIA_DESK_MODEL`、`MEDIA_DESK_API_KEY`。这些配置属于数据服务进程，与某个外部 AI 是否连接 MCP 是两回事。具体安装和运行要求见项目 README；真实登录与可用额度要在部署机器上验证。

确认本次生成授权和可能费用之后，调用：

```json
{
  "name": "media_desk_generation_start",
  "arguments": {
    "id": "<ITEM_ID>",
    "withImages": false,
    "costApproved": true
  }
}
```

`costApproved` 只表示调用方声明本次生成已有授权。**它不是报价、扣费上限、免费保证、余额检查，也不能证明付费平台已取得用户确认。** 调用方仍须依据真实用户授权决定能否发起请求。代码不会因为填了这个布尔值就知道提供方收费多少。

`started: true` 表示任务启动，不代表生成完成。调用 `media_desk_generation_status` 获取 `live.running` 与 `production`，检查 `production.status`、`engine`、`notice` 和图片状态。无模型的结构草稿仍可能完成保存，不能只凭 `status: "done"` 判断是真实模型产物。

需要停止时调用 `media_desk_generation_cancel`。同一条目的整篇生成与单张重画互斥；生成或重画进行中，外部完整稿件／附件写入会拒绝冲突操作。取消请求不能追回已经发生的提供方消耗。

## 8. 协作与交付边界

- 所有客户端连接同一个服务；不要复制 `state.json` 给不同进程各自修改。
- 网页独立入口会轮询外部更新，并在输入、弹窗或助手处理中暂缓同步；这不是实时推送协议。
- `sample: true` 表示示例内容。查找真实素材可以设置 `includeSamples: false`；录入指标必须使用真实来源，不能把示例数据当作账号表现。
- `record_metrics` 是追加操作，新增灵感也是新增操作。发生超时且不知道服务是否已保存时，先查询现状，再决定是否重试，避免重复。
- 排期只维护日历；将状态设为 `published` 只登记已发布事实。当前工具不会自动发布到 X、小红书、YouTube 或其他平台。
- 当前没有暴露任意 shell、任意 HTTP 路由、删除整库、自动平台发布或跨宿主安装工具。需要在客户端运行 Codex／Kimi时，使用它们已具备的能力，再通过这里的接口写回结果。

验证入口为 [`test/standalone-mcp.test.js`](../test/standalone-mcp.test.js)：使用真实官方 SDK、两个 stdio 客户端和一个 Streamable HTTP 客户端，覆盖共享状态、并发新增、完整稿件写入、图片导入挂接、版本冲突和公网链接。该测试使用本地合成内容，不代表真实平台登录或订阅额度已经验收。
