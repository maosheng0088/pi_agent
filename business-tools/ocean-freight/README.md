# 独立海运查询引擎

运行模块完全由本项目独立编写。浏览器与 Node 使用相同的纯 ESM `engine.mjs` 和离线资料 `data/catalog.json`，不会向原参考网站发请求，也不会自动访问船公司、提交表单或修改业务系统。资料历史及来源说明见 `AUDIT.md`。

当前资料包含 51 家船公司、10 家租箱公司、21 个滚装目录、8 类常见箱型、13072 条港口参考记录（13068 个不同代码）、3334 条箱主前缀记录（3333 条历史记录及 CIMU 补充）、3 个船位查询源。港口、箱主与链接均是参考快照，不代表当前官方登记或实时业务状态。

## 工作台与技能部署

独立版 `ocean-freight-tools` 已从 v4 起部署到海运业务查询助手，通过该智能体授权的技能目录执行；后续修补沿用技能中心的版本导入流程，不直接修改已发布目录。它与前端新增的“海运工具”页面复用本目录的引擎与资料。前端入口、构建发布及浏览器验收由工作台的发布流程负责；本说明不将尚未完成的浏览器验收写成已通过。

“海运工具”面向已登录的有效员工，包含号码核验、港口码头参考、船司目录、滚装入口、箱型和船舶搜索入口。页面只使用公共参考目录，不读取其他智能体的聊天或成员资料；海运助手本身的群成员权限和技能共享范围继续由服务端控制。最近查询保存在本浏览器并按账号区分。

本地查询、文件输出与导航动作均不等于实时数据接入。真实运输节点、ETA、实际承运人、开港/可提状态和最新船期需要到对应官网实际查询后，按页面时间与来源报告；访问受阻、验证码、登录或结果缺失必须如实说明。参考箱主数据日期为 2026-07-14，目录整理日期为 2026-10-29，不能混作同一更新时间。4 组重复港口代码保留不同记录 ID，并通过 `codeDuplicateCount` 告知需要核对。

## Node CLI

使用 Node 22.19 或更新版本，无需安装依赖。CLI 从自身目录读取 `data/catalog.json`，不依赖调用时的工作目录。

```powershell
node ./cli.mjs track MSKU1234565
node ./cli.mjs track MSKU1234565 CSQU3054383
node ./cli.mjs ports Rotterdam --country NL
node ./cli.mjs port CNSHA
node ./cli.mjs carriers TRLU
node ./cli.mjs roro ww
node ./cli.mjs types 45G1
node ./cli.mjs vessel "BYD SHENZHEN"
node ./cli.mjs stats
```

智能体处理任意用户输入时，推荐先在工作区写 JSON 文件，再传入 `--request`，避免把原文拼接到 PowerShell。`--request -` 也可以读取标准输入。

```json
{"command":"track","identifiers":["MSKU1234565","000012345678",{"value":"EGLV0000123456","kind":"bill_of_lading","carrierId":"evergreen"}]}
```

```powershell
node ./cli.mjs --request ./request.json --pretty
```

批量核验也可使用 `track --input batch.json`。JSON 必须将号码保存为字符串，否则前导零可能在输入前已经丢失；数值行会明确报错，其余行继续处理。输入文件最大 2 MiB，批量最多 10000 条。普通目录查询每页最多 100 条；`--offset`、`--limit` 控制分页。`--pretty` 为兼容选项，默认 JSON 已缩进排版。没有任何 shell 执行或网络抓取逻辑。

## 浏览器契约

```js
import { executeQuery } from './engine.mjs';
const result = executeQuery({ command: 'ports', query: '上海', country: 'CN', limit: 20 }, catalog);
```

`executeQuery` 为同步函数。`catalog` 应视为只读对象；更换资料时传入新的对象。请求字段：

- `command`：`track`、`carriers`、`ports`、`port`、`roro`、`types`、`vessel`、`stats`。
- `query`：查询文字；`track` 允许按换行、逗号和分号分隔号码，也可以通过 `identifiers` 提供数组。
- `kind`：`auto`、`container`、`bill_of_lading`、`booking`；`bol` 为兼容别名。
- `carrierId`：用户手选的船公司，不证明实际运输关系。
- `country`、`continent`、`lane`：港口地理参考分类筛选。
- `offset`、`limit`：分页。
- `portId`：明确选择一条港口记录。四个港口代码有重复历史记录；输入代码会保留多个候选，只有明确 `portId` 才选择指定记录。

统一响应含 `command`、`query`、`results`、`total`、`offset`、`limit`、`hasMore`、`provenance`、`notes`。`provenance.liveStatusRetrieved` 恒为 `false`，其 `snapshotDate` 与 `ownerSnapshotDate` 分别表示目录和箱主参考快照日期。

`track` 每条结果保存原输入、规范化值、ISO 6346 校验、箱主来源、承运人候选和 `trackingActions`。同一个前缀的中英资料合并展示，来源名称冲突通过 `nameConflict` 和 `sourceNames` 保留。箱主、租箱公司与承运人不能混为一谈。

`trackingActions` 是声明式导航动作：GET 包含 `url`，POST 另外包含 `fields`。浏览器仅在用户主动点击查询时，依据动作打开页面或提交只读查询表单；引擎不执行动作。长荣按箱号使用 `TYPE=CNTR/CNTR`，明确提单查询使用 `TYPE=BL/BL`，订舱等未证实类型退回官网手填。其余携箱号 GET 模板不会自动套用到提单或订舱号。

`port` 返回经纬度、参考地图链接、按球面距离排序的邻近记录，以及相同地理分类的记录。距离不是道路或航程距离；`sameLane` 是地理浏览分类，不表示实际船司服务或可用航线。

`stats` 另外返回 `counts` 和 `filters`；后者含国家、大洲、地理航区的名称和计数。`roro.tools` 为补充滚装入口，`track.aggregators` 为两个外部聚合入口。船位响应仅包含外部搜索链接，没有 AIS 位置或 ETA。

## 验证

```powershell
node --test ./engine.test.mjs
```

测试覆盖全部 16 种船公司携号配置、ISO U/J/Z 校验、未知/租箱/BIC 兜底、来源歧义、前导零、坏行隔离、港口别名与重复代码、分页、邻近距离、GET/POST 编码、危险 URL 和禁用 `fetch` 的全部命令。现有应用账号、调度和生产配置不由此模块修改。
