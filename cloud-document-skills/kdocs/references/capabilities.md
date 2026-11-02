# 金山文档个人账号当前适配范围

Pi 当前基于官方 CLI 2.7.1 注册以下九个受控工具；实际名称和参数仍应通过 `list_tools` 核实，不能直接执行命令行。

| 当前工具 | 实际用途 | 注意点 |
| --- | --- | --- |
| list_my_files | 个人云文档根目录 | 支持当前 schema 定义的分页和筛选。 |
| list_files | 指定文件夹子项 | 使用实际 drive_id、parent_id，不能将文件名当 ID。 |
| search_files | 按文件名或正文搜索 | 按返回结果定位；不要宣称检索到了未返回的文件。 |
| read_file | 提取云文档正文 | url/link_id/file_id 三选一；pending 时使用本次 task_id，检查 warnings 的范围限制。 |
| sheet.get_sheets_info | 取得真实工作表信息 | 先用它确认目标 worksheet_id。 |
| sheet.get_range_data | 读取工作表矩形范围 | 行列为零基，说明真实读取范围。 |
| sheet.range_data_batch_update | 写入单元格内容或公式 | 按 schema 指定范围，执行后核对结果；仅在本轮有修改要求时调用。 |
| create_file_with_content | 新建正文文档或在线表格并写入 | 正文与表格的数据结构不同，按下方格式限制和实际 schema 准备参数。 |
| otl.insert_content | 为 .otl 智能文档追加、前置或替换 Markdown | 定位信息三选一；整篇替换必须有本轮明确覆盖要求，不把它用于 Word/PDF/表格。 |

新建正文支持 file_extension=otl/docx/md/pdf，必须传 content；新建表格支持 xlsx/ksheet，必须传 rangeData（每项为零基 row_from/row_to/col_from/col_to 和 formula 二维数组）。此处新建表格的结构不同于单元格批量更新的 range_data/op_type/formula 字符串，不能混用。目标文件夹可按 schema 提供 drive_id、parent_id；没有明确目录要求时不猜 ID。

已有 .otl 正文写入使用 format=markdown 和 mode=append/prepend/replace，url/link_id/file_id 三选一。不要传 HTML、废弃 pos 参数或未知定位方式。content 上限 100,000 字符，仍受平台单次 JSON 字节数限制；新建表格 rangeData 最多 500 项，二维数组每维最多 100。以实际 schema 和工具返回限制为准。

当前没有开放创建/修改多维表结构、AI PPT、分享或删除接口，也没有任意 Word/PDF 正文直接编辑接口。即使上游官方 Skill 介绍了这些能力，也不能自行拼出名称、调用其他 API 或绕过当前列表。

正文读取在服务支持的文件类型中可能包含 Word、PDF、智能文档、Markdown等，但不保证任意格式和扫描件都可提取，也不代表能够编辑该类型的现有正文。Markdown 可能含 kdocsmd:// 图片地址，这不是可直接下载的 HTTPS 链接；智能文档中返回的临时图片链接也有有效期。表格可能只提取默认工作表或首屏，必须检查 warnings。

官方 CLI 支持 JSON 对象输入；Pi 后端负责编码和进程调用，模型只提交工具要求的参数对象。不要用 PowerShell 拼接中文 key=value、手写大段 Base64、传入 Token、改写 endpoint 或开启 verbose。

工具列表可能只返回部分结果；没找到所需能力时，先用 `list_tools` 的 `params.query` 筛选业务或工具名，再按实际 schema 调用，不自行猜测 CLI 或 API 名称。

官方认证参考明确只支持个人账号；企业账号受控时应停止，并由管理员选择 WPS365 连接。个人知识库、剪藏、PDF 拆分等上游附加能力，只有 Pi 工具列表实际开放时才使用。
