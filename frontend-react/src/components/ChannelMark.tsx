import { Avatar } from '@douyinfe/semi-ui'
import { channelIdentity } from '../lib/artwork'
export default function ChannelMark({type,size=32}:{type:string;size?:number}){const channel=channelIdentity(type);return <Avatar shape="square" src={channel.src} size="small" style={{width:size,height:size,flexShrink:0}} alt={channel.label}>{channel.label.slice(0,1)}</Avatar>}
