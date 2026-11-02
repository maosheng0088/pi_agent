import { Avatar } from '@douyinfe/semi-ui'
import { avatarSource } from '../lib/avatar-catalog'
import {agentIdentities,agentIdentity} from '../lib/agent-identity'
import './agent-avatar.css'
export default function AgentAvatar({title,identity,avatarId,size=40,className}:{title:string;identity?:string;avatarId?:string;size?:number;className?:string}){
 const portrait=avatarSource(avatarId),category=agentIdentity(title,identity),source=portrait||agentIdentities[category].src
 return <Avatar shape="square" className={`agent-avatar ${portrait?'is-portrait':'is-business'} ${className||''}`} data-agent-category={portrait?'custom':category} src={source} size="default" style={{width:size,height:size,borderRadius:Math.round(size*.27),flexShrink:0}} aria-hidden="true">π</Avatar>
}
