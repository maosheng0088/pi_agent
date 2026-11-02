# Pi Agent · 企业智能体协作工作台

基于 Pi SDK 的企业智能体 Web 工作台。每个智能体对应一个协作空间：成员共享会话和资料，不同智能体拥有独立的聊天上下文和工作目录。

## 当前架构

- 网页：React 18、TypeScript、Vite、Semi Design。
- 服务端：Node.js 22.19+、SQLite、Pi Agent SDK；AI 回复采用 SSE，团队状态采用轮询同步。
- `vendor/pi/` 包含当前使用的 Pi SDK 源码快照及上游 MIT 许可证。

支持岗位配置、知识库、群内协作、任务队列、ZIP 技能、定时任务、微信和企业微信渠道、云文档和邮件连接、文件上传与回传、图表和回复卡片、管理员执行日志，以及可恢复的智能体垃圾箱。

## 安装与运行

在仓库根目录执行。依赖安装跳过自动生命周期脚本，然后显式构建 SDK。

```powershell
npm ci --ignore-scripts
npm --prefix frontend-react ci --ignore-scripts
npm --prefix vendor/pi ci --ignore-scripts
npm --prefix vendor/pi run build
npm run build:frontend
npm start
```

访问 `http://127.0.0.1:3210/`，在本机创建第一个管理员，再配置模型、员工和业务连接。SDK 构建需要联网获取其锁定的模型目录数据；生成的模型数据和构建产物不提交到仓库。

默认启动入口 `scripts/start-source-checkout.mjs` 使用仓库内编译后的 SDK，不依赖原开发机器的 `D:\code\pi`。也可通过 `PI_SDK_PATH` 指定其他已经构建的 SDK 入口。

| 环境变量 | 用途 |
| --- | --- |
| `PI_WEB_HOST` | 默认 `127.0.0.1`；局域网访问可设为 `0.0.0.0` |
| `PI_WEB_PORT` | 默认 `3210` |
| `PI_WEB_PUBLIC_URL` | 部署时的 HTTPS 访问地址 |
| `PI_WEB_DATA_DIR` | 私有运行数据目录，默认仓库下 `.data/` |
| `PI_SDK_PATH` | 自定义 SDK 编译入口的绝对路径 |

业务程序需要另外准备 Python 环境、注册配置、授权和浏览器登录状态，详见各程序目录的 README。旧版 Windows 运维脚本保留了原部署环境的路径和域名，使用前应按实际环境配置。

## 源码目录

```text
frontend-react/          当前 React 网页
frontend/                保留的旧版 Vue 前端源码
server.mjs               HTTP、鉴权、会话和任务服务入口
lib/                     技能、任务、连接器、文件和日志服务
business-tools/          海运、Amazon UnitCount、PO 重复检查程序
cloud-document-skills/   云文档技能源码
scripts/                 构建、部署和维护脚本
test/                    后端自动化测试
vendor/pi/               Pi SDK 源码、测试、文档和许可证
desktop/                 已有 Electron 客户端源码
android/                 已有 Android 客户端源码
```

运行后，`.data/` 保存账号、凭据、聊天、技能安装、附件和任务状态，`workspaces/<智能体ID>/` 保存智能体工作文件。这些私有数据不随源码上传。系统命令使用本机进程权限，不提供操作系统沙箱。

## 开发与验证

```powershell
$env:PI_SDK_PATH = (Resolve-Path vendor/pi/packages/coding-agent/dist/index.js).Path
npm test
npm --prefix frontend-react run typecheck
npm --prefix frontend-react test -- --run --maxWorkers=1 --no-file-parallelism
npm run build:frontend
```

前端构建后可运行 `npm run publish:frontend` 发布到兼容静态入口。后端修改需要在任务空闲时重启。

仓库不包含生产账号、密码、API Key、渠道令牌、聊天数据库、附件、智能体工作文件、浏览器登录状态、Cloudflare 凭据、签名私钥、`node_modules` 或安装包。克隆源码不会恢复现有公司的员工、群聊、技能授权或定时配置；这些内容由原机器的私有数据和独立备份保留。

第三方来源见 [许可说明](THIRD_PARTY_NOTICES.md) 和 [Pi 源码快照](vendor/pi/SNAPSHOT.json)。[历史 README](docs/historical-readme.md) 中的旧技术栈和机器路径不作为当前安装步骤。
