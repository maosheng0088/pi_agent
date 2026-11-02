import { Avatar } from '@douyinfe/semi-ui'
import { userAvatarSource } from '../lib/user-avatars'
import { initials } from '../lib/utils'
export default function UserAvatar({name,identity,external,className,size=36}:{name:string;identity?:string;external?:boolean;className?:string;size?:number}){return <Avatar className={className} src={userAvatarSource(identity,external)} size="small" style={{width:size,height:size,flexShrink:0}} aria-hidden="true">{initials(name)}</Avatar>}
