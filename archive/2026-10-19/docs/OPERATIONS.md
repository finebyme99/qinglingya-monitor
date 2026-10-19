# 运行与恢复说明

## 三部分及依赖

1. Worker `hris-qinglingya-test`：读取飞书群消息、MiMo分析、表格同步、卡片投递及按钮处理。
2. Pages `hris-qinglingya-callback`：将卡片回调和受保护监控请求，通过 `BOT` 服务绑定转给Worker。只允许既定路径，不代理管理接口。
3. 外部巡检：现有私有GitHub仓库 `finebyme99/qinglingya-monitor`。工作流每小时第17、47分钟计划执行，可能排队延迟；巡检不调用AI模型。

数据分为飞书多维表格和Cloudflare D1。表格保存业务进展，D1保存消息断点、问题关联、投递去重回执、回调任务和故障事件。仓库只保存 `schema.sql`，不包含这些生产数据。

## 配置与密钥

`wrangler.jsonc` 保留原服务、D1、Durable Object、应用、群、数据表和模型配置。它含资源标识，不含密钥值；不要改为公开仓库。模型使用MiMo的OpenAI兼容接口。

Worker实际密钥继续由Cloudflare Secrets保存：`FEISHU_APP_SECRET`、`MIMO_API_KEY`、`ADMIN_TOKEN`、`FEISHU_VERIFICATION_TOKEN`、`MONITOR_TOKEN`。现役未启用回调加密；若以后启用，再配置 `FEISHU_ENCRYPT_KEY` 并同步平台设置。`.dev.vars.example` 只是空模板。

外部巡检依赖本仓库Secrets：`MONITOR_TOKEN`、`CLOUDFLARE_API_TOKEN`、`FEISHU_APP_SECRET`、`FEISHU_VERIFICATION_TOKEN`，以及平台注入的 `GITHUB_TOKEN`。账号用量令牌为Account Analytics只读。`external-monitor/.env.example` 不含实际值。

本次不读取或导出这些密钥。代码存档不能恢复密钥；换账号或环境时由负责人在对应平台重新配置。

## 在本机验证

本次测试环境是Node.js v22.23.2，测试使用内置模块、模拟网络和内存SQLite。执行：

```sh
npm test
npm run check
node --test external-monitor/test/*.test.mjs
```

原项目没有package-lock.json；本存档保持原依赖声明，Wrangler版本固定为4.144.0。若需部署工具，先在项目根目录执行 `npm install`，不要把依赖缓存入库。

## 恢复或重新发布

下面是需要用户明确确认后才执行的步骤，归档本身不执行它们。

- 复用现有环境时，优先保留现有D1、Durable Object状态和飞书台账，不重建、不清空，不重新启用计划以免重置启用时间。
- 真正迁移到新环境前，先明确数据备份、投递台账和防重发策略；在测试群验证，单独配置正式生效时间。不能只复制代码就宣称已恢复全部进展。
- 核对 `wrangler.jsonc` 的账号、D1、应用、群和表格标识，配置必要的Secrets。换应用后用户open_id也要按新应用重新核对。
- 发布Worker可使用项目既有 `npm run deploy`。发布前执行上述测试；发布后用Ego核对活动版本、通知开关、实时心跳及逐页回执。
- Pages仅在其代码或服务绑定改变时重新发布。当前转接仍指向Worker；既有已发布应用订阅 `card.action.trigger`，回调路径是 `/feishu/card-actions`。
- Worker每分钟的Durable Object Alarm不占Cron Trigger名额。不要因为关闭异常私信停掉该任务。
- 外部巡检的工作流快照位于 `external-monitor/.github/workflows/monitor.yml`。现役巡检使用本仓库根目录的[原有工作流](../../../.github/workflows/monitor.yml)；快照不参与运行，不要另外启用第二份。

## 不产生额外业务消息的核查

`/health` 返回服务、模式与时间节点。受保护的 `GET /monitor/health` 核对运行和投递完整性；`POST /monitor/heartbeat` 只回报服务端时间。管理入口需要独立管理鉴权，不把监控令牌用于管理操作。

不通过正式群试发或真实问题试改做验收；回调的外部成员放行、非群成员拒绝、篡改拦截、重复操作和人工保护均由隔离回归覆盖。真人完成操作后的反馈单独记录，不能以本地通过代替。
