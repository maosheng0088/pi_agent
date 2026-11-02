# 来源、版本与许可

本目录是 Pi 工作台自编的适配说明，版本 1.0.0，核对日期 2026-10-30。它调用腾讯文档官方 MCP，但不是腾讯官方 Skill 压缩包，也不附带官方可执行文件、凭据、安装器或自动更新脚本。

核对的第一方资料：

- 腾讯文档 Skill 概述与能力：https://docs.qq.com/open/document/mcp/skill/
- MCP 概述：https://docs.qq.com/open/document/mcp/
- 获取空间 MCP Token：https://docs.qq.com/open/document/mcp/get-token/
- 腾讯文档团队发布的 MCP 配置指南：https://developer.cloud.tencent.com.cn/mcp/server/11803

官方 Skill 下载地址：`https://cdn.addon.tencentsuite.com/static/tencent-docs.zip`。2026-10-30 核对的官方快照为 1.0.42，共 87 个文件，未发现 SKILL frontmatter 的 license 字段或顶层 LICENSE/COPYING；不推定上游采用 MIT。本包不分发或自动执行该原包，服务仍适用官方实际条款，也不把社区镜像的作者字段当作官方身份依据。

与上游指南的适配差异：原来的安装、Token 配置、MCP 客户端注册、自动升级和反馈流程改由 Pi 管理员面板处理；模型只使用受控的 `cloud_documents`。本文仅概括能力和业务规则，没有复制上游整套手册。腾讯商标、官方服务、上游包和第三方内容保留各自权利。

## 本地适配说明的 MIT 许可

Copyright (c) 2026 Pi Web contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
