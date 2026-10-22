# 系统问题清零鸭 · 完整代码存档

截至2026-10-22更新的项目快照，包含机器人、回调转接、外部巡检、业务规则、测试和恢复说明。存放于私有仓库 [finebyme99/qinglingya-monitor](https://github.com/finebyme99/qinglingya-monitor) 的 `archive/2026-10-19/` 目录，各版本由Git历史保留。

本存档的发布基线是 `20261022-d1-change-only-v17`，Cloudflare Worker版本 `8fab9dc6-88b0-487e-8fa1-9b4b96bff4f2`。未变化的D1数据不再重复更新行，保留分钟检查、人工进展保护、既定汇总节点、卡片容量分页及外部群成员按钮权限。见[发布记录](docs/RELEASES.md)。

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

本次使用Node.js `v22.23.2`。机器人96项、外部巡检10项，共106项测试全部通过，语法检查通过；归档代码与本次验证和发布的源文件逐项核对一致。测试使用虚构数据、模拟请求和内存数据库，不需要生产凭证。

新增的 `test/store.test.mjs` 包含实际分钟检查路径：30个未变问题连续检查60轮，重复关联行变更从1,800降到0，总SQLite行变更从2,196降到312；读取和命令检查次数相同。此为本地测量，不能直接等同生产D1全天额度节省比例。

```sh
npm test
npm run check
node --test external-monitor/test/*.test.mjs
```

## 归档范围

保留代码、模型判断提示词、卡片模板、业务规则、数据库结构、非密钥部署配置及测试。生产群、应用、表格和Cloudflare资源的标识保留在配置里，因此本存档应存放在私有仓库。

不包含任何实际密钥、群聊天记录、员工问题明细、D1数据库内容、飞书表格数据、真实卡片回执、运行日志、浏览器资料、本机认证文件和依赖缓存。故障状态和投递去重账本仍在现有云端；代码存档不能代替数据备份。

本目录始建于2026-10-19，现已更新至上述发布版本。现役外部巡检仍由[仓库根目录](../../README.md)的代码及[定时工作流](../../.github/workflows/monitor.yml)运行；`external-monitor/` 只保留对应快照，不启用第二份巡检。原有Git历史保留在同一仓库。
