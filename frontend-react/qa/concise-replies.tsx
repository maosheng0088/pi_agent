import ReactDOM from 'react-dom/client'
import MessageContent from '../src/components/MessageContent'
import '../src/styles.css'
document.body.classList.add('pi-console-theme')
const introduction = `我是**海运业务查询助手**，本群提供本地校验与目录检索，并可按需通过官网核验。以下是业务入口。

## 五个业务入口

| 入口 | 输入示例 | 可以处理 |

|---|---|---|

| 船公司货物追踪 | 箱号、提单号 | 校验号码、查询候选船司和官方入口 |

| 港口参考 | CNSHA、港名 | 查询参考资料及外部目录 |

| 船公司与租箱公司 | TRLU、MSCU | 区分箱主与实际承运人 |

| 滚装船期 | 目的港、日期 | 查找官方入口 |

| 箱型资料 | 45G1、22G1 | 提供尺寸参考 |

## 交付形式

- 简短结论及必要来源。
- 批量核验清单或已生成文件。

## 核验说明

箱号校验通过不代表实际存在，箱主也不等于本票货物的实际承运人。目录命中和取得官方物流数据分别说明。

以下为隔离样例保留的历史长文，用于验证展开后不再重复摘要。${'详细历史资料仍可展开阅读，原文不会被修改。'.repeat(65)}`
const fields = [{ label: '完成方式', value: '智能体执行' }, { label: '提交人', value: '管理员' }, { label: '结束时间（北京时间）', value: '2026/10/29 11:25' }, { label: '耗时', value: '25 秒' }]
const card = { version: 1, id: 'fixture-result', kind: 'task_result', title: '能力介绍样例', summary: introduction.slice(0, 360), status: 'succeeded', fields }
const short = '箱号 **CSQU3054383** 的格式和校验位正确。尚未查询实际物流状态。'
ReactDOM.createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 850, margin: '24px auto', padding: 16, minWidth: 0 }}>
 <h2 style={{ fontSize: 18 }}>消息展示验收 · 隔离样例</h2>
 <div id="long-example"><MessageContent content={introduction} cards={[card]} /></div>
 <div id="short-example"><MessageContent content={short} cards={[{ ...card, id: 'fixture-short', title: '箱号校验样例', summary: short.slice(0, 30) }]} /></div>
</main>)
