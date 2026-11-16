# 0.1.0 验证记录

验证日期：2026-11-16。所有生成数据为合成测试夹具，没有调用真实模型、付费图片接口或账号作品导入。

## 已验证

| 项目 | 证据与范围 |
| --- | --- |
| 全量业务与适配测试 | `npm test`：148/148 通过，无失败、跳过或取消 |
| 原前端与素材保留 | `npm run verify:frontend`：26 个 `client/` 文件、25 个 `assets/` 文件与固定上游 SHA-256 一致 |
| 独立前端构建 | `npm run build`：React + 原组件 + 原主题打包，约 447 KiB，不加载 DSH 运行时或 CDN |
| 独立 HTTP 服务 | 7 项集成测试：认证、Host/Origin、会话 cookie、目录锁、持久化重启、并发生成和关闭行为 |
| MCP 真实协议 | 4 项集成测试：官方 SDK、两个独立 stdio 进程、第三个 Streamable HTTP 客户端、17 tools / 3 resources、共享数据和图片写回 |
| 多客户端写入 | 并发新增 10 条灵感不丢失；稿件与图片可从原 HTTP state 读回；旧版本完整替换返回冲突 |
| Codex / Kimi adapter | 11 项假 CLI 测试：参数、协议完成、失败退出、输入字面量、环境隔离、超时取消、输出限制、Kimi 权限请求拒绝 |
| 文档接口示例 | MCP 文档的工具/资源清单与实际发现结果一致；JSON 示例可解析并匹配实际 schema |

原项目 Monid 短链测试原先在 fake fetch 下仍调用真实 DNS，导致环境相关失败；现通过依赖注入隔离 DNS，生产默认仍使用真实解析和公开地址校验，同时验证私网/混合 DNS/内网重定向拒绝。

全量测试和浏览器 CI 的最终结果以本仓库 [Actions](https://github.com/q652983601/media-desk-mcp/actions/workflows/standalone.yml) 为准。浏览器 smoke 使用临时数据服务、真实 MCP 写入与 Playwright Chromium；开发容器内的 Chromium 因系统 socket 权限限制不能启动，因此不把本机静态构建当作浏览器验收。

## 尚未验证或不属于本版能力

- 真实 Codex/Kimi 账号、特定型号、订阅额度、真实生成内容质量；安装检测不等于鉴权成功。
- 用户 Mac/Lab 的常驻安装、HTTPS 域名与跨设备访问。
- 原版 DSH 和独立版在同一 OS/字体/浏览器/视口下的逐像素截图对照；当前证明的是原文件完整复用。
- 真实个人 DSH 数据迁移、已保存导出路径在新机器上的恢复。
- 实际图片 API 与 Monid 账号导入；默认没有启用这些可能收费的能力。
- 自动发布到社交平台、远程导出包直接下载、多人权限和 OAuth。
- Kimi 的完整 OS 沙箱；ACP manual 模式和拒绝 reverse RPC 不能保证全部本地文件操作都被隔离。

`expectedRevision` 保护外部完整稿件与附件写入；原 UI 的普通 patch 操作不具有全局 CAS。stdio/HTTP MCP 的工具结果成功也不保证外部平台动作已完成，因为本版不执行社交平台发布。
