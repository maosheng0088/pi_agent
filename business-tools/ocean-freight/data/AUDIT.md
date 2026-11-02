# 海运事实目录来源与构建审计

目录版本：`2026.10.29.2`；schema：`2`；编制日期：2026-10-29。

本目录供独立海运工具本地查询使用。它是**历史衍生参考快照**，不是当前官方 BIC/SCAC 注册库，不证明箱子存在、货权、实际承运人、舱位或实时船期。运行时不请求原研究网站。

## 覆盖与来源

| 集合 | 数量 | 来源与口径 |
| --- | ---: | --- |
| 船司/租箱 | 61 | 51 船司、10 租箱，388 箱前缀、30 B/L 参考标签 |
| 船司携号配置 | 16 | 15 GET（含 MSC Base64）、1 长荣 POST；另45个官网手工入口 |
| BIC 参考代码 | 3,334 | 公开静态快照3,333条＋CIMU补充1条；原公司表2,603项 |
| BIC 携号配置 | 208条/24公司 | 字符串模板转声明式描述符；这些不是208个实时接口 |
| 港口记录 | 13,072 | 基表13,045＋补丁27；只有13,068个唯一码，4个码各有2条历史记录 |
| 港口层级 | 247/24/6 | 国家或地区/地理分区/大洲；名称和编码未经逐条官方核实 |
| 港口标记 | 513/17 | 513条历史主港标记，17条带业务别名；主港标记不是官方评级 |
| 航区 | 33 | 观察到的简短分类名称；逐港归属由本项目独立地理规则生成 |
| 滚装 | 21 | 12个公开船期入口、9个无公开船期参考项 |
| 箱型/船位源 | 8/3 | 指示性箱型参数/外部船位查询入口 |

历史证据来自 2026-10-29 正常浏览公开页面时取得、已保存在本地的资产：

- `https://sea.huodaiagent.com/` 及其 `/carriers/`、`/ports/`、`/roro/`、`/types/` 页面。
- 已保存的 `carriers.js`、`bic-registry.js`、`core.js`、`ports-data.js`、`ports-patch.js`、`roro.js`，以及箱型表、航区分类的 DOM 快照。
- BIC 静态文件自述生成于 **2026-07-14**；CIMU 补充仅声明 **2026-09**，未虚构某个具体日期。
- 原港口文件注释标明衍生自 `Darrenthinker/Maps`；补丁注释提到 `datasets/un-locode` 和 PDDL。这些是来源声明，未独立验证整个衍生库的许可链与官方代码一致性。

上述网址只用于本审计的历史归属说明；不放入运行目录查询字段。构建阶段没有再次访问研究目标，也未调用 BIC API。

## 独立处理与数据异常

构建程序使用 TypeScript AST 读取白名单字面量、解析已捕获的 JSON。**没有 eval、vm、执行下载脚本或复制原站函数**。仅提取名称、代码、国家、坐标、参数与外部链接等事实字段；不收录标志、插图、公开表单密钥、反馈通道或长篇编辑性说明。

箱号 URL 占位符被转换为声明式 `{num}`，Base64 格式为 `{encoded}` 与 `payloadTemplate`；请求方式、允许单号类别、POST 字段单独列出，由独立引擎执行。GET 携号模板只用于集装箱；长荣另有明确的 B/L POST 字段（`TYPE=BL`、`BL`），仅在用户明确选择相应号码类别时使用；其它 B/L/订舱可到官网手填。配置存在不代表链接今日有效或已取到查询结果。

发现并处理的异常：

- **4组重复港口代码**：AEJEA、USLAX、MYTPP、USNYC。保留两条历史事实，不擅自认定哪条正确；第二条 `id` 加 `~2`，两条都标 `codeDuplicateCount:2`。按代码查询须保留多候选，不能用 Map 覆盖。
- **1个损坏的箱主官网网址**：保留公司和代码，将网址置空；构建回执保存其哈希和原因，没有猜测或修补成新网址。
- 中文译名沿用历史参考，并应用源补丁的一条勘误；全部 `nameVerified:false`，不标为已官方核实。
- 官方代码、业务俗称和别名不混同。所有港口 `codeVerified:false`，别名位于独立 `aliases` 数组。
- 航区规则仅按国家、地理区域、坐标及有限主港集合做浏览分类，`metadata.laneAssignment='geographic_reference'`。它不证明存在航线、实际承运、直航或船期。

## 字段约定

- 顶层：`schemaVersion, metadata, stats, carriers, roro, types, ports, countries, regions, continents, lanes, owners, vesselSources, aggregators, roroTools, hotPortCodes`。
- 港口：`id`唯一；`code`可能重复；`country/region/continent`为代码，对应的 `*Name`是显示名称；`lat/lon`为历史经纬度；`main`为历史标记；`aliases/lanes`始终是数组。
- 箱主：`code`为4字母前缀，`ownerCode`为前三位；`website/homePage`可为空；可选 `tracking`含纯数据的 GET 描述符。实际归属和存在性始终未核实。
- 船司 `tracking.method`为 GET/POST/PAGE。POST采用声明式字段，不含脚本函数；URL仅允许 HTTP(S)、无内嵌账户凭据。

## 使用与许可信息

本次导入依据用户明确要求，用已保存的公开静态事实构建独立系统；没有据网页注释推定获取了额外授权或“官方认证”。捕获的原文件未提供统一可验证的数据许可声明；本记录列出已知来源和缺口，供维护时核实。

后续如替换为官方来源，应按对应服务/发布包的具体条款和更新机制处理：[BIC API 条款](https://www.bic-code.org/api-terms-of-use/)、[NMFTA SCAC 数据服务](https://scac.nmfta.org/pricing)、[UN/LOCODE 发布页](https://unlocode.unece.org/publications/)。本次没有下载或分发 BIC API 返回数据，也不将公开静态快照冒充实时官方服务。

## 重建与检查

构建脚本：`D:/code/pi-web/qa/ocean-independent-20261029/build-catalog.mjs`。原始证据位于 `D:/code/pi-web/qa/huodaiagent-research-20261029/`。脚本所需 TypeScript 仅用于构建，生成目录没有运行依赖。

构建回执 `dataset-build-receipt.json` 记录输入文件 SHA-256、输出大小及计数。`catalog.test.mjs` 检查完整覆盖、唯一记录ID、重复代码保留、所有坐标范围、国家/区域/大洲关系、补丁/别名、无原站运行依赖、安全URL、携号配置和快照语义。数据检查不等同于逐条证明名称、坐标或外部链接现在准确。
