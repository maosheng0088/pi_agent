import ReactDOM from 'react-dom/client'
import { ConfigProvider } from '@douyinfe/semi-ui'
import zhCN from '@douyinfe/semi-ui/lib/es/locale/source/zh_CN'
import MessageContent from '../src/components/MessageContent'
import '../src/styles.css'
import './rich-messages.css'

document.body.classList.add('pi-console-theme')
const results = `## 提柜资料核对结果

**已核对 10 项，8 项完成，2 项等待补充资料。**
本页均为验收用合成数据。

| 任务 | 负责人 | 状态 | 下一步 |
| :--- | :--- | :---: | :--- |
| A-001 | 小李 | 已完成 | 归档核验清单 |
| A-002 | 小王 | 待补充 | 补充提柜日期 |
| A-003 | 小陈 | 待补充 | 上传装箱单 |

### 待办事项
1. 核对缺失资料
   - 确认提柜日期
   - 补齐装箱单
2. 资料齐全后重新提交。

- [x] 已完成的项目已归档
- [ ] 两项待补资料尚未提交

> 建议：今天下班前补齐资料，提交前请复核原单。

完成率为 $r=8/10$。

$$
r=80\\%
$$`
const code = ['### 检查脚本', '', '```python', 'def completion_rate(done, total):', '    if total == 0:', '        return 0', '    return done / total', '', 'print(completion_rate(8, 10))', '```', '', '### 资料处理流程', '', '```mermaid', 'flowchart LR', '  A[收到资料] --> B[核对字段]', '  B --> C{资料完整}', '  C -->|是| D[生成结果]', '  C -->|否| E[补充资料]', '```', '', '### 页面报告', '', '```html', '<!doctype html><html><head><style>body{font:16px sans-serif;padding:24px;background:#eff5ff}.card{background:white;border-radius:12px;padding:24px;color:#244a74}strong{font-size:30px;color:#198b75}</style></head><body><div class="card"><h2>提柜日报</h2><strong>8 / 10</strong><p>两项待补资料 · 合成数据</p><details><summary>查看说明</summary><p>请补齐提柜日期和装箱单。</p></details></div></body></html>', '```'].join('\n')
const long = '## 核验明细\n\n已完成本次核验，以下为完整记录。\n\n' + Array.from({length:32}, (_, index) => `### 第 ${index + 1} 项\n\n任务编号 QA-${String(index + 1).padStart(3,'0')}，需保留原始字段和处理结论。该项为验收示例，不代表真实业务数据。\n`).join('\n') + '\n**完整记录结束，原文已全部保留。**'
function Preview(){return <ConfigProvider locale={zhCN}><main className="rich-qa"><header><span>PiConsole · 组件验收</span><h1>每条回答，都清晰呈现</h1><p>使用实际消息组件 · 合成业务数据 · 保留现有聊天布局</p></header><div className="rich-qa-grid"><article data-case="business"><h2>业务回答</h2><div className="chat-bubble"><MessageContent content={results}/></div></article><article data-case="code"><h2>代码与流程图</h2><div className="chat-bubble"><MessageContent content={code}/></div></article><article data-case="card"><h2>任务结果卡片</h2><MessageContent content={'**已完成资料核验。**\n\n- 核验总数：10 项\n- 已完成：8 项\n- 待补充：2 项\n\n请补充提柜日期及装箱单。'} cards={[{version:1,id:'qa-result',kind:'task_result',title:'提柜资料核对',status:'succeeded',fields:[{label:'提交人',value:'验收用户'},{label:'完成方式',value:'合成结果'}]}]}/></article><article data-case="long"><h2>较长回复</h2><div className="chat-bubble"><MessageContent content={long}/></div></article><article data-case="plain"><h2>普通问答</h2><div className="chat-bubble"><MessageContent content={'这票需要先补齐装箱单，再安排提柜。\n\n**下一步：**请上传装箱单，我会继续核对。'}/></div></article><article data-case="literal"><h2>原始资料与异常格式</h2><div className="chat-bubble"><MessageContent content={'原始字段：<status>待核验</status>。\n\n金额为 $20，补充费用 $30。\n\n| 字段 | 值 |\n\n| - | - |\n\n| 标识 | `x|y` |\n\n| 金额 | USD 1280 |\n\n未闭合代码也应保留：\n\n```json\n{"reference":"QA-001","amount":"1280.00","status":"待核验"}'}/></div></article></div></main></ConfigProvider>}
ReactDOM.createRoot(document.getElementById('root')!).render(<Preview/> )
