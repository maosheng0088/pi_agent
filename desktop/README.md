# PiConsole Windows 桌面端

这是连接现有 Pi Web 的 Windows 客户端，默认使用 `https://ai.junweirpa.asia/`。群聊、智能体管理、技能、定时任务和文件保持与网页端同步。客户端不包含服务端数据、员工密码、模型 API 密钥或业务脚本，业务执行仍在原服务器完成。0.2.0 起使用 Windows NSIS 安装版及 electron-updater。

```powershell
npm ci
node node_modules/electron/install.js
npm run build:icons
npm test
npm run test:runtime
npm run build
npm run test:updates-runtime
npm run publish:update
```

输出为 `release/installer/PiConsole-Setup-0.2.1-x64.exe`、`latest.yml` 和 `.blockmap`。安装到当前 Windows 用户，无需重新配置账号或服务器。0.1.0 的 ZIP 试用版没有更新模块，需要安装一次新版；后续客户端自动下载更新，点击“安装并重新启动”完成更新。安装器会替换原“PiConsole 桌面试用版”快捷方式，保留旧目录。普通网页界面与业务功能仍随服务器发布，无需更新客户端。

客户端启动时及运行中每 15 分钟检查公司更新源。`minimumVersion` 高于当前版本时，会进入本地强制更新页，不能跳过或切换服务器绕过；下载出错可重试，已知最低版本策略在本机缓存，断网不会撤销已知的更新要求。客户端低于 `latestVersion`、但满足最低版本时，后台下载并提示可稍后安装。安装动作只在下载完成后开放，不在普通退出时自动运行安装器。

发布新桌面版本：修改 `package.json` 及锁文件中的版本号，更新 `RELEASE_NOTES.json`，构建并通过两类运行时验收，再执行 `npm run publish:update`。脚本先校验安装器版本、SHA-512 和大小，发布安装器及 blockmap，最后原子更新 `public/desktop-updates/windows/latest.yml` 与 `policy.json`。默认最低支持版本设为本次版本，即强制更新；需要可选更新时，显式执行 `npm run publish:update -- --minimum-version 0.2.0`。已发布的安装器不能被不同内容覆盖，版本和最低版本不能降低。无需重启 Pi Web 服务。

公司更新源固定为 `https://ai.junweirpa.asia/desktop-updates/windows/`。下载前验证版本、同源路径及 SHA-512 元数据，electron-updater 验证下载文件校验和；当前试用安装包尚未配置 Authenticode 代码签名。当前源使用完整安装包下载，保留 blockmap 供之后增量下载适配。`test:updates-runtime` 验证真实 NSIS 包下载及校验、强制更新界面与 IPC 门禁；测试不实际覆盖安装用户客户端。

客户端使用独立 Chromium 登录目录 `%APPDATA%/PiConsole`，关闭后保留登录状态。普通关闭会退出客户端，不影响服务器任务。F11 切换全屏，Ctrl+R 刷新，菜单可切换公司服务器和本机 3210 服务。外部网页交给系统浏览器，同源文件预览保持在沙箱窗口。下载使用保存对话框，不自动打开文件。

远端页面关闭 Node 集成，启用 contextIsolation、sandbox 和 webSecurity。远端页面不暴露桌面 IPC；连接恢复页面使用限定资源的 `piconsole://app/` 协议，并校验 IPC 发送窗口、主 frame 和 URL。测试使用独立本机 HTTP 服务与临时登录目录，不登录生产账号。
