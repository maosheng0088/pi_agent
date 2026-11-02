import type {Session} from './types'
const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:0
export function sessionAttention(session:Session){
 const {unreadCount,resultCount,mentionCount,pendingCount}=session.attention||{}
 return {unread:count(unreadCount),results:count(resultCount),mentions:count(mentionCount),pending:count(pendingCount)}
}
export function needsAttention(session:Session){const a=sessionAttention(session);return a.unread>0||a.pending>0}
export const badgeCount=(value:number)=>value>99?'99+':String(value)
