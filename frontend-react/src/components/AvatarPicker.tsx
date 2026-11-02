import { Radio, RadioGroup } from '@douyinfe/semi-ui'
import { useId } from 'react'
import { avatarOptions } from '../lib/avatar-catalog'
import {agentIdentities,agentIdentity} from '../lib/agent-identity'
import './agent-avatar.css'
export default function AvatarPicker({value,onChange,disabled=false,label='头像',businessTitle}:{value:string;onChange:(value:string)=>void;disabled?:boolean;label?:string;businessTitle?:string}){
 const id=useId(),business=businessTitle===undefined?null:agentIdentities[agentIdentity(businessTitle)]
 return <fieldset className="avatar-picker" disabled={disabled}><legend id={id}>{label}</legend><p>{business?'按名称自动匹配业务图标，也可以选择固定头像。':'选择一张头像，或使用自动推荐。'}</p>{business&&!value&&<p className="automatic-avatar-hint">当前自动图标：{business.label}</p>}<RadioGroup className="avatar-options" aria-labelledby={id} value={value} onChange={event=>onChange(event.target.value)} disabled={disabled}>
 <Radio value="" className="avatar-option">{business?<span className="auto-business-avatar"><img src={business.src} alt="" width="44" height="44"/></span>:<span className="auto-avatar">π</span>}<span>自动推荐</span></Radio>
 {avatarOptions.map(option=><Radio value={option.id} key={option.id} className="avatar-option"><img src={option.src} alt="" width="44" height="44" loading="lazy"/><span>{option.label}</span></Radio>)}
 </RadioGroup></fieldset>
}
