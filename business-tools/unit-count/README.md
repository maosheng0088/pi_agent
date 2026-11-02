# Amazon UnitCount 定时检查适配器

此适配器由 Pi 定时任务和专用智能体共用。原程序 `D:/影刀开发/影刀程序/测UnitCount` 的源码保持不变，运行时按引用加载其飞书客户端、搜索客户端、查询时间算法和 `carrier_key`，不复制凭据。

## 执行方式

```powershell
& 'C:/Users/32062/AppData/Local/Programs/Python/Python310/python.exe' 'D:/code/pi-web/business-tools/unit-count/run.py' 'D:/code/pi-web/.data/unit-count-registration.json' --preflight
```

注册文件为第一个位置参数，包含 `sourceDir`、`outputDir` 和 `notifyWecom:false`。`loginMode` 默认 `browser-refresh`，`loginTimeoutSeconds` 默认 600 秒（最多 900 秒），验证码等待包含在此登录时限内。可选 `maxTotalSeconds` 默认 1200 秒，最多 1500 秒，预留调度器终止前的报告落盘时间。

`networkMode` 默认 `system`，沿用 requests 的系统/环境代理发现。若本机代理影响此任务，可明确配置为 `direct`：仅本适配器使用 `Session(trust_env=False)` 直连，TLS 证书校验保持开启，不改环境变量、Windows 代理或其他任务。其他网络模式拒绝执行。

| 参数 | 行为 |
| --- | --- |
| `--preflight` | 只检查 Python、requests、DrissionPage、psutil、必需源码和适配器；不执行原源码，不读 Cookie 内容，不联网，不写运行报告。浏览器刷新模式允许尚无旧 Cookie，通过不等于真实登录有效。 |
| `--latest` | 读取脱敏后的最近一次报告，不联网。无记录时返回 `status:not_run`。 |
| `--result RUN_ID` | 读取指定报告，不联网；限制运行 ID，禁止路径穿越。 |
| `--check` 或不传模式 | 从飞书读取承运人配置，按原账号和专属 Chromium 端口完成登录及英文页面校验，刷新原目录 Cookie，再查询 Amazon。验证码由管理员在浏览器完成；有界等待后继续或明确失败，无阻塞式 `input()`。 |

定时和手动检查均不修改飞书或 Amazon 预约。登录适配器读取原飞书账号密码完成登录，且仅在校验通过后原子更新原程序的 Cookie、令牌及端口账户绑定文件，不改原程序源码。绑定文件只含账户指纹。拒绝复用其他浏览器配置目录；任务不关闭管理员已有标签页。登录失败不能使用旧 Cookie 继续检查。

Pi 调度器监听本次 `<runId>.attention.json`，验证码或二次验证需要人工处理时，在绑定智能体中向管理员投递提醒；不发送到外部渠道，不触发 AI。账号选择和密码填写自动完成，不能确定对应账号时明确失败，不盲选其他账号。管理员在任务电脑的专属 Chromium 窗口完成验证，最长等待 10 分钟。群内手动启动通过 `run_unit_count_check` 使用同一 Pi 任务入口。命令行直接运行属于维护入口，其标准输出可见等待原因，但不独立发送群通知。`latest` / `result` 始终只读历史报告。`loginMode:saved` 仅为明确配置的兼容维护模式。

## 判断与报告

查询窗口沿用原程序：北京时间“两个月前的 1 日零点，至明天零点”。仅检查 `ARRIVAL_SCHEDULED` 和 `PENDING_SCHEDULE`。`unitCount` 为数字 `0` 才记零值异常；布尔值、字符串、空值、缺字段、负数及非有限数字一律列为检查失败，空 shipment 列表也不算正常。

每条预约分别计正常、零件数异常、检查失败；非目标状态单独计跳过。承运人登录或会话刷新失败使本轮不完整。`auth_required` 只代表登录或访问校验未通过，不能单凭此错误判定 Cookie 过期、账号停用或密码错误。若同一预约既有零值、又有无效字段，会同时保留异常证据和失败原因，不能据此认定全部检查完成。

进度日志只打印步骤、计数及固定错误码；不打印 Cookie、密码、认证 URL、原始 HTTP 错误或完整响应。传输强制 HTTPS 和允许的官方域名，拒绝登录跳转；单次连接/读取、重试次数、响应大小、总时长均有上限。

运行 ID 优先取 `PI_BUSINESS_RUN_ID`，其次 `RPAC_EXECUTION_ID`，否则新建 UUID。报告原子写入 `outputDir/<runId>.json` 和 `outputDir/latest.json`，相同运行 ID 不覆盖。可选明细过多时报告保留准确汇总，并用 `omittedDetails` / `omittedShipmentDetails` 说明省略数量，结果小于 1 MiB。原始 HTML 和完整认证响应均不保存。

实际检查使用系统文件锁防止定时任务与智能体手动检查同时访问。锁由操作系统管理，进程正常退出、被取消或崩溃后自动释放，不依赖删除 PID 文件。检查忙时仍保存该次失败报告（`check_already_running`），但保留真正查询的 `latest.json`；预检和历史查询不抢占检查锁。摘要包含北京时间、查询范围、前 10 条零值异常明细和按承运人列出的中文失败原因。

投递摘要最多 15000 个 UTF-8 字节，中文按实际字节计；超过时在完整行边界截断并说明，原始结构化明细仍保留在报告中。

```json
{
  "schemaVersion": 1,
  "taskType": "unit-count-check",
  "runId": "运行 ID",
  "status": "completed",
  "businessOutcome": "abnormal",
  "complete": true,
  "startedAt": "北京时间 ISO 字符串",
  "finishedAt": "北京时间 ISO 字符串",
  "timezone": "Asia/Shanghai",
  "window": {"from": "北京时间 ISO 字符串", "to": "北京时间 ISO 字符串"},
  "counts": {},
  "findings": [],
  "failures": [],
  "skipped": [],
  "carriers": [],
  "notification": "disabled",
  "summary": "可直接投递到智能体的汇总"
}
```

- `status:completed` + `businessOutcome:normal|abnormal`：检查完整，退出码 `0`。发现零值属于真实业务异常，不伪装成程序崩溃。
- `status:partial|failed` + `businessOutcome:incomplete|failed`：存在检查失败或缺失，退出码 `2`。即使零值条数为 0，也不能报告正常。
- `counts` 包含 `carriers`、`carriersChecked`、`carriersFailed`、`carriersSkipped`、`appointments`、`checked`、`normal`、`abnormal`、`failed`、`skipped`、`shipments`、`zeroUnitShipments`、`invalidUnitShipments`。

默认关闭原企业微信通知，由 Pi 投递到绑定智能体。只有管理员明确将注册文件改为 `notifyWecom:true` 才启用原配置的企业微信机器人通道；没有 findings 时不发消息。

离线回归：`python qa/unit-count-integration-20261029/test_adapter.py`。所有测试使用临时目录和假客户端，不读取原始凭据或访问业务网络。
