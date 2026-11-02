import assistant from '../assets/workspace/agent-icons/assistant.svg'
import ocean from '../assets/workspace/agent-icons/ocean.svg'
import po from '../assets/workspace/agent-icons/po.svg'
import unit from '../assets/workspace/agent-icons/unit.svg'
import quote from '../assets/workspace/agent-icons/quote.svg'
import pickup from '../assets/workspace/agent-icons/pickup.svg'
import warehouse from '../assets/workspace/agent-icons/warehouse.svg'
import sync from '../assets/workspace/agent-icons/sync.svg'
import finance from '../assets/workspace/agent-icons/finance.svg'
import support from '../assets/workspace/agent-icons/support.svg'
import document from '../assets/workspace/agent-icons/document.svg'
import team from '../assets/workspace/agent-icons/team.svg'
import automation from '../assets/workspace/agent-icons/automation.svg'
import mail from '../assets/workspace/agent-icons/mail.svg'

export const agentIdentities={
 assistant:{src:assistant,label:'通用助手'},ocean:{src:ocean,label:'海运业务'},po:{src:po,label:'预约与 PO 检查'},unit:{src:unit,label:'数量核验'},
 quote:{src:quote,label:'报价业务'},pickup:{src:pickup,label:'提柜与派送'},warehouse:{src:warehouse,label:'仓储业务'},sync:{src:sync,label:'数据同步'},
 finance:{src:finance,label:'财务对账'},support:{src:support,label:'客户服务'},document:{src:document,label:'文档与单证'},team:{src:team,label:'团队协作'},
 automation:{src:automation,label:'自动化任务'},mail:{src:mail,label:'邮件助手'},
} as const
export type AgentIdentity=keyof typeof agentIdentities

/** Specific business names win over broad words such as data, customer or task. */
export function agentIdentity(title:string,identity?:string):AgentIdentity{
 if(/unit[\s_-]*count|件数|数量核验|数量检查|零件数/i.test(title))return 'unit'
 if(/\bpo\b|重复(?:预约|检查)|预约(?:检查|核验)|加约/i.test(title))return 'po'
 if(/报价|询价|估价|quote|pricing/i.test(title))return 'quote'
 if(/财务|对账|账单|费用|成本|应收|收款|付款|finance|billing/i.test(title))return 'finance'
 if(/提柜|提货|派送|派车|调度|pickup|dispatch/i.test(title))return 'pickup'
 if(/海运|船期|船司|船公司|货物追踪|ocean|freight|shipping/i.test(title))return 'ocean'
 if(/仓库|仓储|入库|出库|warehouse/i.test(title))return 'warehouse'
 if(/邮件|邮箱|email|mailbox/i.test(title))return 'mail'
 if(/同步|sync|gsheet|pierpass|terminal/i.test(title))return 'sync'
 if(/客服|客户|customer|support/i.test(title)||identity==='01a17c19-6616-72b6-8e2a-86f24b0c032b')return 'support'
 if(/文档|文件|单证|报关|知识库|飞书|腾讯文档|金山|document|pdf/i.test(title))return 'document'
 if(/团队|人事|协作|成员|team|hr\b/i.test(title))return 'team'
 if(/定时|计划|日程|自动化|RPA|schedule|cron|automation/i.test(title))return 'automation'
 return 'assistant'
}
