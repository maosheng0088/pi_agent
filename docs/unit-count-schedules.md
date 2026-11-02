# Amazon 预约 UnitCount 检查

部署日期：2026-10-29。专用智能体为“预约件数检查助手”，群 ID `01a18669-fa14-72da-add1-9b60d439eea9`。初始仅管理员加入，可按既有成员管理流程邀请员工。

访问：[工作台](https://ai.junweirpa.asia/#agent=01a18669-fa14-72da-add1-9b60d439eea9)。

## 定时计划

时区固定为 Asia/Shanghai，每天执行四次，全部已启用。每天的四个时段和手动复查分别去重；原有三个业务任务继续按原来的每日规则执行。

| 北京时间 | 计划 ID |
| --- | --- |
| 04:00 | e408a681-2be0-4c78-b639-f1f625eb5af8 |
| 09:30 | 11a5c5ab-8c5e-4c3e-b210-91e7f3ef9498 |
| 14:00 | 582b0d2a-aab4-4f88-b2ed-d458da59fffb |
| 18:00 | d63dbc0c-d291-4781-a1bd-2eec0eddbcaf |

业务执行器 ID 为 `amazon-unit-count`。程序直接由 Pi 调度，不经过模型决定是否启动，也不依赖 RPAC 或影刀客户端在线。原目录 `D:/影刀开发/影刀程序/测UnitCount` 作为现有飞书配置、只读客户端和保存登录状态的来源保留，原 Python 源码未修改。

入口：`D:/code/pi-web/business-tools/unit-count/run.py`。固定解释器：`C:/Users/32062/AppData/Local/Programs/Python/Python310/python.exe`。私有注册配置：`.data/unit-count-registration.json`，业务白名单：`.data/business-tasks.json`。此任务设置 `networkMode: direct`，避免本机系统代理导致 Python ProxyError；HTTPS 证书校验继续开启，不修改系统代理。

## 结果和登录状态

检查复用保存的 Cookie，后台不强制打开登录窗口或等待回车。登录失效、无权访问、请求失败、缺少字段等均计为检查未完成；不能将空异常列表当作检查正常。

数值型 UnitCount 为 0 属于已确认业务异常；布尔值、文本、空值和缺失字段不等同于数值零。只检查 `ARRIVAL_SCHEDULED`、`PENDING_SCHEDULE` 两类预约，时间窗口沿用原规则：北京时间两个月前月初至明天零点。

程序报告写入 `.data/unit-count-results/<runId>.json` 与 `latest.json`。完整检查（正常或发现业务异常）退出 0；部分完成或失败退出 2。Pi 根据本轮报告及退出码保存真实运行状态，结果摘要自动投递专用智能体；程序 print/stdout/stderr 进入管理员执行日志。默认不再重复向原企业微信群发送通知。系统文件锁防止定时与手动检查重叠。

专用技能 `amazon-unit-count` 仅共享到本群，支持读取最新报告、指定运行报告、静态预检和按用户要求执行一次只读检查。查询已有结果不发起新的 Amazon 检查。

## 验证记录

相关后端测试 76 项通过、1 项 Windows 符号链接权限跳过；离线 API 端到端测试 1 项通过；适配器离线测试 28 项通过；技能客户端测试 5 项通过，技能校验通过。

真实验收运行 `aa88e0ec-4f3a-4631-94df-7355f4bd4c0f` 已记录失败且结果已投递：飞书成功读取到 1 个承运人，Amazon 登录验证未通过，预约数据尚未完成检查。需要管理员更新该账号保存的登录状态后再检查；这不是“业务异常为零”。原有三个计划、46 个账号和原项目源码均已核对保留。

部署配置和验收证据位于 `qa/unit-count-integration-20261029/`，数据库备份路径记录在同目录的 `deployment.json`。源程序凭据和登录 Cookie 不打包进技能。
