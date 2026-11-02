# 来源、版本与许可

本包是 Pi 自编的 WPS365 云文档技能封装，版本 1.0.0，核对日期 2026-10-30。它不声称是上游官方 Skill，不打包 CLI 可执行文件、凭据或上游安装器。

第一方来源：

- WPS365 官方 CLI 原仓：https://github.com/wps365-open/cli
- 官方 README（能力、认证、凭据及许可证声明）：https://github.com/wps365-open/cli/blob/main/README.md
- 官方发行版本：https://github.com/wps365-open/cli/releases
- WPS 云文档业务介绍：https://open.wps.cn/documents/app-integration-dev/wps365/server/yundoc/introduce

上游 README 声明 CLI 使用 MIT 许可证；实际二进制的许可证和第三方声明以管理员安装的发行包为准。本地包没有复制上游实现或整套手册，仅概括能力与接入边界。CLI 的安装/授权/自动更新流程被替换为 Pi 管理员“云文档连接”，模型只调用受控工具。WPS/金山商标和服务保留各自权利。

## 本地适配说明的 MIT 许可

Copyright (c) 2026 Pi Web contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
