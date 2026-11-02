# RPAC 三个业务项目迁移至 Pi 定时任务

切换日期：2026-10-28。首次自动执行日期：2026-10-29，Asia/Shanghai。

| 项目 | 固定项目版本 | 每日北京时间 | Pi 计划 ID |
| --- | --- | --- | --- |
| gsheet-terminal-fill | v2 | 08:00 | 63095c51-7a39-4c09-bbba-c3abb9200cd7 |
| feishu-pickup-sync | v5 | 08:05 | a38b5668-23f6-414b-bf1f-e7ad7f5ed4f4 |
| pierpass-terminal-sync | v2 | 08:10 | aa0bd4b1-36f9-46ec-b92c-5e02868890bb |

时间以切换时 RPAC 数据库的 cron 和 APScheduler 实际下一次执行时间核对：UTC 00:00、00:05、00:10，对应北京时间 08:00、08:05、08:10。旧业务迁移文档中 09 点的描述不作为本次依据。

结果群：业务定时任务，群 ID `01a17e9c-394f-7012-a912-61772a23dc01`。初始只有创建管理员，群成员由管理员按既有群成员流程添加。

Pi 使用 `.data/business-tasks.json` 中的固定环境和项目入口，直接执行已安装的 Python 环境，无需 RPAC Master/Worker 在线。原代码、业务私有配置、数据目录、缓存、通知配置均沿用现有 RPAC 项目。入口使用原任务的 `--mode manual`，确保固定的 08 点计划不会受到旧 registration.json 中 09 点阈值影响；Pi 自身的业务日 claim 和项目锁控制重复执行。

切换时已停用 RPAC 中以上三项任务，并删除对应 APScheduler 计划。原 cron 配置保留以供回退。其它 RPAC 任务不在本次迁移范围内。回退前应先停用 Pi 这三个计划、确认执行结束，再恢复 RPAC 计划，避免两边同时执行。

备份：

- Pi：`.data/backups/workspace-before-rpac-business-1793125424066.sqlite`
- RPAC：`D:/代码/RPAC/backups/pi-three-migration-20261028.dump`

上线验证包括完整 195 项测试、隔离浏览器假项目执行与日去重、三个现有环境的依赖导入检查、本机业务浏览器连通检查，以及生产计划日期/时间核对。未执行三个真实业务项目、未发起业务写入或业务通知；明日执行结果需以运行记录和业务审计为准。

执行时需要电脑、Pi Web、现有业务浏览器和网络保持可用。日志保存在 `.data/business-logs/`，仅群内管理员可通过运行记录查看；业务群只接收安全摘要。超过十五分钟的陈旧业务计划跳过，不自动重放，失败或中断也不重复写入；已保存结果可单独补发。
