# 来源、版本与许可

本目录是 Pi 自编适配说明，版本 1.0.0，核对日期 2026-10-30；后端使用官方 kdocs-cli，但本包不分发 CLI，也不是金山文档官方 Skill 原包。

第一方来源（官方仓库默认分支是 master）：

- 官方仓库：https://github.com/kdocs-app/kdocs-skill
- 已核对的 Skill 2.7.1：https://github.com/kdocs-app/kdocs-skill/blob/master/SKILL.md
- 个人/企业账号边界与授权：https://github.com/kdocs-app/kdocs-skill/blob/master/references/auth.md
- 金山文档授权入口：https://www.kdocs.cn/latest

2026-10-30 核对的官方 2.7.1 原包含 630 个文件，存在 Windows 反斜杠 ZIP 路径，超过 Pi 的 500 条目限制；本包重新编写了最小适配说明，不能把原档当成本 Pi ZIP。原包未发现 SKILL frontmatter 的 license 字段或顶层 LICENSE/COPYING，不推定上游采用 MIT。

本包仅概括上游操作语义，不复制上游安装、自动升级、feedback、保存 Token 指令或整套参考文档。模型不执行这些上游管理步骤；安装、授权和更新改由 Pi 管理员面板完成。官方包、CLI 和服务仍适用上游实际附带的许可/服务条款。金山/WPS 商标保留各自权利。

## 本地适配说明的 MIT 许可

Copyright (c) 2026 Pi Web contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
