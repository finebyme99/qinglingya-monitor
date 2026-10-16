# 清零鸭外部监测

独立于 Cloudflare 的私有 GitHub Actions，每小时第17、47分钟探测，GitHub排队可能延迟。正常不通知，异常只通过清零鸭私信固定接收人；不发送群消息。适用于免费、非秒级告警。

检查真实回调 challenge（最多两次）、受保护的只读健康入口、账号 UTC 日 Workers 请求、D1行读写、Durable Objects请求、运行时长与SQL读写行数。用量80%、95%、100%各提醒一次，UTC零点（北京时间08:00）重置。Analytics可能延迟或采样，不是实时账单承诺；后台显示与API统计应分别保留。健康检查包括计划、心跳、逐页正式投递和按钮任务失败。

issue #1 保存机器去重状态，不保存凭证或业务问题正文。发送前保存UUID；未知回执停止自动重发。连续同一异常只提醒一次，探测恢复后重新布防；正常恢复不另发消息。私信失败使工作流失败，需核对日志和去重台账。

依赖仓库四项Secrets：MONITOR_TOKEN（仅健康读取）、CLOUDFLARE_API_TOKEN（本账号Analytics只读）、FEISHU_APP_SECRET、FEISHU_VERIFICATION_TOKEN（真实challenge验证），以及GitHub自动注入的GITHUB_TOKEN。不得提交凭证文件。

标准Linux runner每月约1440–1488次，单次目标不足1分钟；每月预计约1500免费分钟。长超时会增加用量，免费分钟为账号共享。没有启用付费计划或扩大付费预算。源程序不调用模型。
