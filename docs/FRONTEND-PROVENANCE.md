# 原版前端保留与独立运行说明

## 复用基线

- 原项目：[woniuniuniu/dsh-media-desk](https://github.com/woniuniuniu/dsh-media-desk)
- 固定版本：`2.7.2`
- 固定提交：[`3a23cb899691c29238138c76deb200114ce1830c`](https://github.com/woniuniuniu/dsh-media-desk/tree/3a23cb899691c29238138c76deb200114ce1830c)
- `client/` 的 26 个源码文件与 `assets/` 的 25 个图片、视频文件逐字节保留。
- 原许可证保留在仓库根目录 `LICENSE`：MIT，Copyright (c) 2026 woniuniuniu（蜗牛的科技笔记）。

运行 `node scripts/verify-frontend.mjs` 会用基线提交中的 SHA-256 核对上述 51 个文件，并拒绝新增、删除或修改。核验程序不依赖 Git，可随源码包一起运行。它证明复用了原始前端源码和素材；逐像素视觉一致性还取决于浏览器、字体、宿主主题和数据状态。

## 新增的独立运行外壳

`standalone/client.jsx` 直接调用原入口 `client/index.jsx` 的 `apply(ctx)`。不到一页的 slots 适配器捕获原 `Desk` 组件交给 ReactDOM 挂载。侧栏注册在独立页面没有对应宿主，故不另画侧栏。没有复制或重写各业务页面。

构建把 React、ReactDOM 与原组件一起打包，不加载 `@deepseek-ai/*` 运行时、Cordis 或 `window.__ModuleLoader__`。`standalone/theme.css` 仅补全页面容器高度和清除浏览器默认边距。

原界面的灵感、内容、排期、复盘、风格、成稿工作区、助手、设置、弹窗、动效和布局均来自同一份 `client/`。由于源码完整保留，设置说明等少量文字仍保留上游的 DSH 名称；这些文字不表示独立版运行时需要 DSH。模型、订阅生图与账号导入是否可用由独立后端实际提供的能力决定。

## 主题来源

插件原 CSS 使用宿主语义颜色、圆角、阴影、字体和滚动条定义。为保留这些视觉值，只内置官方 CSS，不安装或运行 DSH。

- 来源：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 固定提交：[`39163dd30f703a79079e2d2446545cff3c453738`](https://github.com/deepseek-ai/deepseek-harness/tree/39163dd30f703a79079e2d2446545cff3c453738)，对应 `0.2.2-rc.3`。
- 原目录：`packages/client/ui-theme/src/styles/`。
- 本地目录：`standalone/theme/`。
- 许可证：`standalone/theme/LICENSE`，MIT，Copyright (c) 2026 DeepSeek。

| 源文件 | 用途 | SHA-256 |
| --- | --- | --- |
| `base.css` | 字体栈、圆角 | `803926ce39f5ea48b652021d06b6ca65c4acc7be2c5c4e19bd904ab1dabf0b67` |
| `design-platform.css` | 明暗主题原色与语义色 | `3234f318769ea5065013793d58d98b235948486789d69ea16e850bd3713babcc` |
| `gradient-shadow-text.css` | 阴影、描边和主题排版值 | `b6e1e8387edbfa60ec03bb29aad7c01245c0adbd22229d5a6f2916caa7e7b427` |
| `corner-shape.css` | 支持浏览器的原版连续圆角 | `d94f82e1332b6d37e8345aafe1b6b4129faed65891edd3861c00b88940ec4d3f` |
| `scrollbar.css` | 原滚动条外观 | `d83797aa96625e8ec77412bfc5649469cd5834d3cb0f7f6a1f3db8a59e1f4530` |

主题默认跟随系统。验收时可用 `/?theme=light` 或 `/?theme=dark` 固定明暗主题，用 `&lang=zh` 或 `&lang=en` 指定页面语言；已保存的工作台语言设置仍优先。原版本没有自带中文网络字体，宋体/系统字体沿用浏览器的原始字体栈；跨 macOS 与 Linux 截图不能视为逐像素一致性证据。

## 构建与服务器契约

```sh
node scripts/verify-frontend.mjs
node scripts/build-standalone.mjs
```

构建依赖 `esbuild`、`react`、`react-dom`。输出在 `dist/standalone/`：

- `/`：`index.html`
- `/app.js`：浏览器 ESM bundle，含全部前端和主题 CSS，无 CDN 请求。
- `MEDIA-DESK-LICENSE.txt`、`THEME-LICENSE.txt`：随构建分发的许可证。

后端须同源提供原 `GET/POST /media-desk/*` 契约及 `/media-desk/assets/*`、`/media-desk/files/*`。前端依赖普通 fetch 和 700ms 成稿状态轮询，无 WebSocket。认证由独立服务的同源会话负责，不把 MCP Bearer token 写入前端。

独立外壳额外每 2 秒读取一次状态，使 MCP 客户端写入的内容在工作台内可见。隐藏标签页、输入中、对话请求中和表单弹窗打开时暂停同步；请求期间本地状态有变化时丢弃该次同步结果。原界面操作与成稿轮询保持原实现。

## 视觉验收边界

必需基线是同一源提交、同一份示例数据、同一浏览器/操作系统/字体、相同工作台视口和主题。应比较工作台内容区域，排除原 DSH 外层导航与系统窗口装饰。

建议覆盖：灵感散落/信息流、内容看板/列表、排期、复盘、风格、成稿、设置与助手；检查 1440×900 桌面和 390×844 移动视口、明暗主题以及中英文溢出。定格系统时间、动画与视频帧后做截图差异，另行实际操作画布缩放拖动、卡片展开、日历排期、文字编辑、复制和素材导出。

源码完整性与构建通过不等于所有后端功能验收通过。需要真实模型或账号的调用、图片生成额度、跨设备导出以及原 DSH/独立版的同环境像素对照，须分别记录是否验证，不能仅靠静态截图宣称完成。


## CLI 设置入口增量

`standalone/cli-settings.jsx` 通过独立外壳在原设置表单中挂载 CLI 配置入口，专用配置弹窗复用原 Dialog、字段与按钮样式。原 client 和 assets 文件保持上述基线。四种 CLI 的配置、安装检测、保存错误与版本冲突反馈属于独立外壳新增功能，需随实际浏览器验证记录接收。

设置入口现为「配置 Magpie 模型与 CLI」，Magpie 网关与本机 CLI 使用两个标签页。新增网关表单沿用同一主题和字段样式，client 与 assets 的 51 文件完整性检查继续覆盖原基线。
