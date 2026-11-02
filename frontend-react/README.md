# Pi Console · React + Semi Design

现用前端：React 18、TypeScript、Vite 8、Semi Design 2.104.0。服务端仍使用现有 Pi Agent SDK 与 Node API，业务数据和权限不做迁移。

在项目根目录执行：

```powershell
npm --prefix frontend-react ci
npm run dev:frontend
npm --prefix frontend-react test -- --maxWorkers=1
npm run build:frontend
npm run publish:frontend
```

开发服务 http://127.0.0.1:5174 代理现有 http://127.0.0.1:3210/api。构建先在本目录完成类型检查与打包，再将资源和入口写入服务器使用的 `frontend/dist`；发布脚本同步 `public`。更新纯前端无需重启业务任务服务。构建保留旧哈希资源，避免更新时已经打开的浏览器丢失资源。

主界面、聊天、登录使用 Semi 的导航、输入框、选择器、按钮、头像、标签与弹窗。管理页按需加载。`src/lib/workspace.ts` 管理账号、群授权、轮询和 SSE；`src/lib/message-links.ts` 只允许已登记的本地附件预览，外部图片按链接处理。

原 Vue 源码保留在 `../frontend/src`，迁移前入口备份位于 `../.data/backups/semi-react-before-20261028`。回滚时恢复该目录备份的 `frontend/dist/index.html` 与根 `package.json`，同步发布即可；业务数据库没有因本次 UI 迁移发生改动。
