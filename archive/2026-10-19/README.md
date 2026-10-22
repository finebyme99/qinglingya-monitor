# 系统问题清零鸭 · 完整代码存档

截至2026-10-22更新的项目快照，包含机器人、回调转接、外部巡检、业务规则、测试和恢复说明。存放于私有仓库 [finebyme99/qinglingya-monitor](https://github.com/finebyme99/qinglingya-monitor) 的 `archive/2026-10-19/` 目录，各版本由Git历史保留。

本存档的发布基线是 `20261022-prepush-analysis-v18`，Cloudflare Worker版本 `647fb1ff-f594-477a-a375-c8f29cb94d17`。未变化的D1数据不再重复更新行，节点前10分钟集中识别，发卡时读最新表格；保留轻量分钟心跳、按钮即时处理、人工进展保护、既定汇总节点及原安全校验。相关截图交由MiMo结合上下文判断，避免泛化占位建单。见[发布记录](docs/RELEASES.md)。

| 内容 | 位置 |
| --- | --- |
| 机器人、卡片、AI分析、台账和定时任务 | [src/](src/) |
| 数据库结构（不含业务数据） | [schema.sql](schema.sql) |
| Worker部署配置（不含密钥值） | [wrangler.jsonc](wrangler.jsonc) |
| Pages回调转接 | [callback-bridge/](callback-bridge/) |
| 外部巡检代码和工作流快照 | [external-monitor/](external-monitor/) |
| 现役业务规则 | [业务规则](docs/BUSINESS_RULES.md) |
| 当前发布和验证范围 | [发布记录](docs/RELEASES.md) |
| 恢复、部署和密钥配置说明 | [运维说明](docs/OPERATIONS.md) |
| 后续AI协作约束 | [AGENTS.md](AGENTS.md) |
| 归档清单、版本和文件校验值 | [ARCHIVE_MANIFEST.json](ARCHIVE_MANIFEST.json) |
| 原项目说明及历史验收线索 | [历史说明](docs/history/PROJECT_NOTES.md) |

## 本地验证

本次使用Node.js `v22.23.2`。机器人113项、外部巡检10项，共123项测试全部通过，语法检查通过；归档代码与本次验证和发布的源文件逐项核对一致。测试使用虚构数据、模拟请求和内存数据库，不需要生产凭证。

`test/prepush.test.mjs` 验证三个准备与推送节点、人工更新、失败恢复、周末和跨日断点；`test/image-context.test.mjs` 验证图片来源、多模态请求与泛化重复建单校验。30个问题连续60轮普通分钟检查，SQLite行变更180次、业务表及群消息读取均为0；此为本地逻辑行变更，不等同生产全天计费额度。真实只读MiMo核查成功处理4张相关图片；未发送测试消息或代真人点击实际问题。

```sh
npm test
npm run check
node --test external-monitor/test/*.test.mjs
```

## 归档范围

保留代码、模型判断提示词、卡片模板、业务规则、数据库结构、非密钥部署配置及测试。生产群、应用、表格和Cloudflare资源的标识保留在配置里，因此本存档应存放在私有仓库。

不包含任何实际密钥、群聊天记录、员工问题明细、D1数据库内容、飞书表格数据、真实卡片回执、运行日志、浏览器资料、本机认证文件和依赖缓存。故障状态和投递去重账本仍在现有云端；代码存档不能代替数据备份。

本目录始建于2026-10-19，现已更新至上述发布版本。现役外部巡检仍由[仓库根目录](../../README.md)的代码及[定时工作流](../../.github/workflows/monitor.yml)运行；`external-monitor/` 只保留对应快照，不启用第二份巡检。原有Git历史保留在同一仓库。
