export interface User { id: string; username: string; displayName: string; role: 'admin' | 'member' | string; disabled?: boolean; createdAt?: string }
export interface Workspace { id?: string; name: string }
export interface Session {
  id: string; title: string; ownerId?: string; createdByName?: string; ownerName?: string;
  createdAt?: string; updatedAt?: string; revision?: number; messageCount?: number;
  running?: boolean; activeUserId?: string; activeUserName?: string; mode?: string;
  provider?: string; model?: string; cwd?: string; memberCount?: number;
  lastMessage?: string; description?: string; avatarId?: string; [key: string]: any
}
export interface Message {
  role: string; content: string; timestamp?: string | number; authorId?: string; authorName?: string;
  authorUnknown?: boolean; tools?: unknown[]; taskRunId?: string; messageIndex?: number; pending?: boolean;
  [key: string]: any
}
export interface Skill { id: string; name: string; description?: string; enabled?: boolean; scope?: string; groupIds?: string[]; avatarId?: string; [key: string]: any }
export interface Schedule { id: string; name: string; enabled?: boolean; sessionId?: string; [key: string]: any }
export interface MembersResponse { members: User[]; externalMembers?: Array<{id:string;displayName:string;source:string}>; canRemoveMembers: boolean; canLeave: boolean; leaveBlockedReason?: string; ownerId?: string }
export type View = 'chat' | 'skills' | 'schedules' | 'channels' | 'users' | 'audit' | 'events'
