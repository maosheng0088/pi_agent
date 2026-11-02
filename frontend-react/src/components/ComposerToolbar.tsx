import {useId,useRef,useState} from 'react'
import {Button,Popover,Radio,RadioGroup,Select} from '@douyinfe/semi-ui'
import {IconClose,IconLayers} from '@douyinfe/semi-icons'
import type {ReactNode} from 'react'
import type {Skill} from '../lib/types'

interface Props {
 collaboration:boolean; mode:'agent'|'discussion'; onMode(value:'agent'|'discussion'):void;
 mentions:string[]; onMentions(value:string[]):void; mentionOptions:Array<{value:string;label:string}>;
 skills:Skill[]; selectedSkill:string; onSkill(value:string):void; busy:boolean;
 attachment?:ReactNode; children:ReactNode;
}
export default function ComposerToolbar({collaboration,mode,onMode,mentions,onMentions,mentionOptions,skills,selectedSkill,onSkill,busy,attachment,children}:Props){
 const mentionLabel=useId(),skillLabel=useId()
 const [panel,setPanel]=useState<'mentions'|'skills'|null>(null),mentionTrigger=useRef<HTMLSpanElement>(null),skillTrigger=useRef<HTMLSpanElement>(null)
 const close=(kind:'mentions'|'skills')=>{setPanel(null);requestAnimationFrame(()=>{(kind==='mentions'?mentionTrigger:skillTrigger).current?.querySelector('button')?.focus()})}
 const escape=(event:React.KeyboardEvent<HTMLDivElement>,kind:'mentions'|'skills')=>{if(event.key==='Escape'&&!event.currentTarget.querySelector('.semi-select-open')){event.stopPropagation();close(kind)}}
 const chosen=skills.find(skill=>skill.id===selectedSkill)
 return <div className="composer-toolbar unified-composer-toolbar" role="group" aria-label="消息工具栏">
  {collaboration&&<RadioGroup type="button" value={mode} aria-label="消息发送方式" onChange={event=>onMode(event.target.value)} className="composer-mode"><Radio value="agent"><span className="mode-desktop">交给 AI</span><span className="mode-compact" aria-hidden>AI</span></Radio><Radio value="discussion"><span className="mode-desktop">群内讨论</span><span className="mode-compact" aria-hidden>讨论</span></Radio></RadioGroup>}
  <div className="composer-tools">
   {collaboration&&<Popover trigger="click" position="topLeft" visible={panel==='mentions'} onVisibleChange={visible=>setPanel(previous=>visible?'mentions':previous==='mentions'?null:previous)} onEscKeyDown={()=>close('mentions')} content={<div className="composer-control-panel" onKeyDownCapture={event=>escape(event,'mentions')}><div className="composer-control-heading"><strong id={mentionLabel}>提及协作成员或智能体</strong><Button htmlType="button" theme="borderless" icon={<IconClose aria-hidden/>} aria-label="关闭提及选择" onClick={()=>close('mentions')}/></div><p>选择需要关注这条消息的人；@智能体 会创建 AI 任务。</p><Select aria-labelledby={mentionLabel} multiple filter showClear optionList={mentionOptions} value={mentions} onChange={value=>onMentions((value||[]) as string[])} placeholder="搜索姓名或选择智能体" className="composer-mention-picker"/><div className="composer-control-footer"><Button htmlType="button" theme="solid" onClick={()=>close('mentions')}>完成</Button></div></div>}><span ref={mentionTrigger} className="composer-popover-trigger"><Button htmlType="button" theme="borderless" className={`composer-tool ${mentions.length?'has-selection':''}`} aria-label={`提及成员${mentions.length?`，已选 ${mentions.length} 位`:''}`}><span className="mention-symbol" aria-hidden>@</span>{mentions.length>0&&<span className="composer-selection-count" aria-hidden>{mentions.length}</span>}</Button></span></Popover>}
   {attachment}
   {skills.length>0&&<Popover trigger="click" position="topLeft" visible={panel==='skills'} onVisibleChange={visible=>setPanel(previous=>visible?'skills':previous==='skills'?null:previous)} onEscKeyDown={()=>close('skills')} content={<div className="composer-control-panel" onKeyDownCapture={event=>escape(event,'skills')}><div className="composer-control-heading"><strong id={skillLabel}>本次调用技能</strong><Button htmlType="button" theme="borderless" icon={<IconClose aria-hidden/>} aria-label="关闭技能选择" onClick={()=>close('skills')}/></div><p>{mode==='discussion'?'切换为“交给 AI”后可指定技能。':'默认由智能体选择，也可以指定本次任务的技能。'}</p><Select aria-labelledby={skillLabel} value={selectedSkill} onChange={value=>{onSkill(String(value||''));close('skills')}} disabled={busy||mode==='discussion'} optionList={[{value:'',label:'自动选择技能'},...skills.map(skill=>({value:skill.id,label:skill.name}))]}/></div>}><span ref={skillTrigger} className="composer-popover-trigger"><Button htmlType="button" theme="borderless" icon={<IconLayers aria-hidden/>} className={`composer-tool composer-skill ${chosen?'has-selection':''}`} aria-label={chosen?`选择技能，当前 ${chosen.name}`:'选择技能，当前自动选择'}><span className="composer-tool-label">{chosen?chosen.name:'技能'}</span></Button></span></Popover>}
  </div>
  <span className="composer-spacer"/>{children}
 </div>
}
