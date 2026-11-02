# 加约存档测 PO 重复：Pi 定时任务适配器

此适配器读取原程序 `D:\影刀开发\影刀程序\加约存档测PO重复`，不修改其 Python 源码。Pi 负责定时启动、管理员执行日志、验证码提醒和结果投递。每日时间由 Pi 定时任务配置；本任务为北京时间 16:00。

## 保留的业务流程

1. 使用原配置，从飞书多维表读取全部承运人；账号仍按原浏览器端口区分。
2. 复用原 `sheets_reader.py`：读取当月及上月工作表，保留两个业务表的列映射、10/20 天日期窗口、FBA 拆分、私人仓过滤、合并日期补齐和 Q=YES 筛选。
3. 有待查 FBA 时，逐账号通过专属 Chromium 刷新登录、中文界面和 Cookie，再使用 Python HTTP 查询原预约接口。Cookie/Token 仍保存在原程序 `secrets`，使用原端口文件名。
4. 同一来源 FBA 在同一承运人账号下，返回至少配置阈值个有效预约，才计为重复；不同账号各命中一个不算重复。`CLOSED`、`DELETED`、`CANCELLED` 不计入有效预约。
5. 保存每次运行报告，Pi 将安全摘要投递到绑定智能体。没有符合筛选条件的 FBA 时，明确报告“未发起预约查询”，不会声称已验证无异常。

两个检查任务共用内核浏览器锁，整个业务运行持锁，避免 UnitCount 与本任务互相改变登录状态或界面语言。遇到验证码或二次验证时，程序通过专用 attention 文件提示管理员，验证完成后自动继续。

## 与原脚本有意区别

- 不导入原 `run.py`、`auth.py`、`notifier.py`、`notify.py`；没有企业微信外发，也不启用 `SKIP_LOGIN` 或开发 Cookie 兜底。
- 保留重复判定规则，同时修正两处来源聚合问题：跨月来源键包含 `sheet_id`；读取行补齐到实际请求列宽，缺失 Q 列按空白处理，不能绕过 Q=YES。
- HTTP 200 的 HTML、错误 JSON、错误工作表范围或缺少必要结构会记为失败，不作为“零预约”。缺月份、账号失败、查询失败均会使检查不完整。
- 汇总中的预约数量按“来源行 × 账号”累计命中次数，不冒充去重后的全局预约数量。
- 网络只允许飞书官方只读 GET、飞书鉴权 Token POST，以及 Amazon 原查询 GET。使用直连、TLS 校验和独立线程 Session，每次请求前后清空隐式 Cookie，禁止通知接口及业务写入。

## 注册文件与命令

注册文件由服务端保存，不包含复制的账号密码或密钥，例如：

```json
{
  "sourceDir": "D:/影刀开发/影刀程序/加约存档测PO重复",
  "outputDir": "D:/code/pi-web/.data/po-duplicate-results",
  "networkMode": "direct",
  "maxTotalSeconds": 3000,
  "loginTimeoutSeconds": 600,
  "maxWorkers": 4
}
```

```text
python business-tools/po-duplicate/run.py <注册文件> --preflight
python business-tools/po-duplicate/run.py <注册文件> --check
python business-tools/po-duplicate/run.py <注册文件> --latest
python business-tools/po-duplicate/run.py <注册文件> --result <运行编号>
```

`--preflight` 仅做静态检查，不访问飞书、Amazon 或浏览器。`--check` 会执行原业务查询，须由 Pi 调度器启动。运行编号优先读取 `PI_BUSINESS_RUN_ID`，其次 `RPAC_EXECUTION_ID`。

## 报告与日志

- `<runId>.json`：本次报告，包含 `schemaVersion:1`、`runId`、`completed/partial/failed`、计数、异常明细和失败阶段。
- `latest.json`：最近一次运行报告的原子快照。
- `<runId>.attention.json`：仅在需要人工验证时写入，不含账号、密码、Token、URL 或内部路径。
- 报告不超过 1 MiB，摘要不超过 15,000 UTF-8 字节；超出明细保存上限会通过 `omittedDetails` 明示，业务计数保持完整。
- 普通进度日志仅输出固定阶段和数量；凭据不进入日志或报告。Pi 管理员日志另有读取权限控制。

退出码：`0` 表示检查完成或静态预检通过，`2` 表示失败／不完整／预检未通过，`3` 表示指定历史报告不存在。重复运行编号不会覆盖旧记录。

离线验证：

```text
python qa/po-duplicate-integration-20261029/test_adapter.py
```

这些测试仅使用临时目录、假账号、假响应及纯读取规则，不访问生产业务网络、真实浏览器或生产锁。
