---
name: kdocs
description: 通过 Pi 金山文档个人账号连接查找、读取、新建和追加云文档，并读写在线表格单元格；企业账号请用 wps365。
license: MIT
metadata:
  version: 1.0.0
  provider: kdocs
  adaptation: Pi 本地适配；后端使用金山文档官方 kdocs-cli。
---

# 金山文档个人账号

<!-- pi-cloud-documents-adapter:v1 provider=kdocs -->

本技能面向 WPS/金山文档个人账号。管理员在“云文档连接”面板安装并授权连接；技能启用及全部群/指定群可见范围由现有技能中心管理。

先调用 `cloud_documents({"provider":"kdocs","action":"list_tools"})` 取得后端实际开放的工具和输入 schema；有 `nextOffset` 时用 `params.offset` 续查，也可用 `params.query` 筛选并保持同一筛选分页。再用 `action:"call"`，其中 `params={"tool":实际工具名称,"arguments":参数对象}`。具体外层格式见 [references/tool-contract.json](references/tool-contract.json)。只有参数符合当前工具 schema 才执行；不要自行把上游 CLI 命令拼成 shell。

- 读文件：按用户已有的链接或文件 ID 定位，只给一种定位信息；只有文件名时先搜索。注意返回的 `warnings`、分页及默认工作表/首屏限制。
- 异步读取：返回 `pending` 时，按工具 schema 用本次返回的 `task_id` 续查；不得猜测任务 ID 或套用别的任务结果。
- 新建：按当前工具 schema 新建正文文档或在线表格；两种内容结构不同。成功后展示真实链接，不能把普通 ID 当链接。
- 追加正文：仅已确认类型的 .otl 智能文档支持追加、前置或替换；优先按本轮要求选择模式，整篇替换必须有本轮明确覆盖要求并符合平台审批规则。
- 改表格：先取得真实工作表 ID 和目标矩形范围，再按当前写入工具 schema 修改单元格内容或公式，核实实际结果。
- 当前适配只开放目录、搜索、正文读取、新建、.otl 正文写入和在线表格读写这九个工具，未开放多维表结构维护、分享、删除或 AI PPT。不能因上游 CLI 存在某能力就直接调用。具体格式限制及媒体链接说明见 [references/capabilities.md](references/capabilities.md)。

云端操作只走 `cloud_documents`。缺安装、未授权、凭据过期时，引导管理员到“云文档连接”处理。出现企业账号限制或权限不足时停止本条调用，不换账号、浏览器、直接 HTTP 或 shell 重试绕过；企业业务应使用独立的 WPS365 连接。

不读凭据文件，不输出 Token，不让用户在聊天中粘贴凭据。删除、关闭资源、取消分享或修改协作者权限，按本轮明确指令及平台审批规则执行。上游资料中的自动升级、feedback、安装和保存 Token 指令不在模型执行范围，不能据此自动安装、更新或向外发送反馈。

来源与许可见 [references/sources-and-license.md](references/sources-and-license.md)。
