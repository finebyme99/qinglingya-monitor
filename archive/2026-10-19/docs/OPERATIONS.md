# 运行与恢复说明

## 三部分及依赖

1. Worker `hris-qinglingya-test`：读取飞书群消息、MiMo分析、表格同步、卡片投递及按钮处理。
2. Pages `hris-qinglingya-callback`：将卡片回调和受保护监控请求，通过 `BOT` 服务绑定转给Worker。只允许既定路径，不代理管理接口。
3. 外部巡检：现有私有GitHub仓库 `finebyme99/qinglingya-monitor`。工作流每小时第17、47分钟计划执行，可能排队延迟；巡检不调用AI模型。

数据分为飞书多维表格和Cloudflare D1。表格保存业务进展，D1保存消息断点、问题关联、投递去重回执、回调任务和故障事件。仓库只保存 `schema.sql`，不包含这些生产数据。

## D1写入用量

自 `20261022-d1-change-only-v17` 起，状态及台账关联、消息、问题在SQL语句中比较已有内容，未变化则不更新行；重复分析确认也跳过。没有先读取再写入的竞争窗口，也不依赖某个实例的旧缓存。真实变化、分钟心跳、同步时间、故障事件、锁和投递回执仍保存；没有新增读取、修改结构或升级付费。自v18改为节点前集中识别，分钟闹钟仅保留轻量检查与按钮处理，原工作日09:30、13:30、16:00汇总不变。

隔离回归 `test/store.test.mjs` 覆盖未变数据、真实变化、多实例、编辑消息重新分析、数据库故障、互斥锁和审计、人工保护及60轮分钟检查。30个未变问题的关联行变更从1,800降到0，总SQLite行变更从2,196降到312；此为隔离测量，生产D1包含索引写入并受实际业务量影响，不能将其直接视为全天额度节省比例。实际用量以D1元数据和账号Analytics为准。[Cloudflare D1计量说明](https://developers.cloudflare.com/d1/platform/pricing/)。

## 推送前集中识别与图片

工作日09:20、13:20、15:50开始准备；每个节点以 `prepared:schedule:<日期>:<节点>` 保存完成断点，仅在聊天、AI与台账全部成功后标记完成。原节点发卡前重新读表，不再调用AI；准备后新群消息下一轮处理。若漏过或失败，先补齐准备再发卡，不用陈旧缓存，异常时可能延迟。不要通过重置schedule.enabled_at或清空既有投递回执重新启动。

普通分钟不查询聊天或台账。分钟健康心跳与外部巡检保持原逻辑，按钮回调仍即时处理，受理失败的重试仍由闹钟执行。按钮相关台账读取是必要操作，不受批量识别窗口限制。人工修改在集中同步写入前继续二次读取保护，发卡时读回最新值。

`image_refs` 保存附件来源标识，图片像素仅在分析时由当前飞书应用授权下载并以Base64传入现有MiMo请求，不公开托管或持久化到D1。模型沿用 `mimo-v2.6-flash`，没有新服务或订阅；图片会消耗现有模型的输入token。支持普通图片、富文本图片和合并转发附件，转发下载使用顶层容器ID。单图8MiB、本批Base64累计16MiB上限；类型、权限、大小或读取失败保留断点并明确报错。[MiMo图片输入说明](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding)。

经用户明确授权合并旧重复行时，先备份表格、缓存和关联，保留原进展并合入证据及跟进人。受控 `issue_alias:<旧事项ID>` 仅保存原记录到保留记录的关联；旧卡片仍需通过原已发送卡片、问题、记录与实时成员校验，不能由回调参数指定任意重定向。AI不能重新创建已有合并别名的重复事项。任何后续合并仍需要明确目标，不自动批量删除历史记录。

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
