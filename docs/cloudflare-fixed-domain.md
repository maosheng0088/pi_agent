# Cloudflare 固定域名的 Pi 源站

公开地址预设为 `https://ai.junweirpa.asia`，本机源站为 `http://127.0.0.1:3210`。
此文档和脚本不包含 Cloudflare Token，不创建 Tunnel 或 DNS。

## 已部署状态（2026-10-29）

- 公网入口：`https://ai.junweirpa.asia`；现有员工继续使用原账号登录。
- 专用 Tunnel：`pi-workspace`，ID `ff8ea829-7103-4ed9-bb67-f54dc59f412d`，Windows 连接器 `2026.10.5`。
- Published application：`ai.junweirpa.asia` → `http://127.0.0.1:3210`，DNS 已自动创建，其他 Tunnel 路由保留。
- 当前用户任务：`PiWeb-Cloudflare-Workspace`；用户登录 Windows 15 秒后启动，每分钟进行幂等恢复检查，普通权限，无保存的 Windows 密码。
- 自动入口：`scripts/ensure-cloudflare-workspace.ps1`；需要手动重新注册启动项时运行 `scripts/register-cloudflare-startup.ps1`。
- 本机需保持开机、联网，并保持该 Windows 用户登录。恢复检查不会停止正在执行工作的进程。
- 切换前备份：`.data/backups/cloudflare-before-20261029`。

已验证：公网登录、Secure/HttpOnly/SameSite Cookie、未登录私有数据保护、跨源请求拦截、4 个原有群聊和 3 项启用中的计划保留；实际浏览器登录及聊天页面加载成功。验收没有向业务群发送测试消息。

## Cloudflare 连接器

已在 `tools/cloudflared/cloudflared.exe` 安装官方 Windows 连接器。域名当前使用 Cloudflare 的 `hunts.ns.cloudflare.com` 与 `noor.ns.cloudflare.com` 名称服务器。

登录管理该域名的 Cloudflare 账号后，创建或复用 Pi 的命名 Tunnel，添加公开主机名 `ai.junweirpa.asia`，服务类型 HTTP，服务地址 `127.0.0.1:3210`。保留默认公开 Host，不设置覆盖本机 Host 的选项。

连接器凭据仅保存于受保护的 `.data/cloudflare/tunnel-token.txt`；不放到文档、命令行或前端。完成源站公开地址配置后，使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\code\pi-web\scripts\start-cloudflare-tunnel.ps1
```

脚本会验证源站、检查本项目已有连接器进程，再在后台启动。未配置凭据或已有源站不接受域名时会停止并报告；不结束其他进程。实际公网访问仍需完成 Cloudflare 登录、Tunnel、DNS 与 HTTPS 验收。

## 固定启动入口

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\code\pi-web\scripts\start-cloudflare-origin.ps1
```

此入口在每次启动时显式传入 `PI_WEB_PUBLIC_URL`、监听地址和端口。
默认后台运行；需要前台日志时加 `-Foreground`。默认仅监听本机，需要保留现有局域网入口时显式传入 `-BindAddress 0.0.0.0`。
如果已有本项目服务占用端口，脚本会用公开 Host 和 HTTPS Origin 检查它；已正确配置就保留进程，未配置则报错。
脚本不会结束已有进程，也不会把“端口已监听”误报为域名配置已生效。

长期启动的服务或启动项应调用此脚本，而不是直接调用 `node server.mjs`。
进程当前已经启动时，改变环境变量不会修改该进程；首次启用域名需要在运行任务结束后受控重启。
本脚本不写全局用户或系统环境变量，也不修改账号、群聊或任务数据。

## 反向代理必须满足的应用条件

- 公网入口使用 HTTPS，域名与 `PI_WEB_PUBLIC_URL` 完全对应。
- 反代目标使用本机 HTTP 源站；请求头 `Host` 保留为 `ai.junweirpa.asia`，不要替换成 `localhost` 或 `127.0.0.1:3210`。
- 聊天流使用 SSE，应允许持续响应，保留流式传输并关闭响应缓冲和转换。
- `/api/`、认证、聊天流和私有附件不得设置强制缓存。
- 不需要开放本机 3210 的公网入站端口。

应用在 `lib/security.mjs` 检查 Host 与 Origin；`server.mjs` 根据 HTTPS 公开地址设置 Secure Cookie。
仅设置 `X-Forwarded-Proto` 无法替代公开地址配置。浏览器 API 与附件都走同源地址，前端不需要另设 API 域名。

## 验收

1. 本机 `http://127.0.0.1:3210/api/auth/status` 可以访问。
2. 固定启动入口的公开 Host 与 Origin 检查通过。
3. 域名入口完成员工登录，Cookie 带 `HttpOnly; SameSite=Strict; Secure`。
4. 员工只能看到已有成员权限内的智能体；进入群聊、查询记录、收取流式回复、下载授权附件正常。
5. 隧道和 Pi 服务分别重启后仍能使用相同域名与登录账号。

当前登录限速和审计采用连接的原始远端 IP（`lib/accounts.mjs`）。经本机隧道进入时会显示隧道本机 IP，多个用户共用 IP 级失败登录限额；账号级限速仍独立生效。真实员工 IP 的记录需以后增加明确的可信代理策略，不能直接信任外部可伪造的转发头。
