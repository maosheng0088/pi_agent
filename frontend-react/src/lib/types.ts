export interface User { id: string; username: string; displayName: string; role: 'admin' | 'member' | string; disabled?: boolean; createdAt?: string }
export interface Workspace { id?: string; name: string }
export interface SessionAttention { unreadCount: number; resultCount: number; mentionCount: number; pendingCount: number }
export interface Session {
  id: string; title: string; ownerId?: string; createdByName?: string; ownerName?: string;
  createdAt?: string; updatedAt?: string; revision?: number; messageCount?: number;
  running?: boolean; runningTaskCount?: number; queuedTaskCount?: number; conversationRunning?: boolean; activeUserId?: string; activeUserName?: string; mode?: string;
  provider?: string; model?: string; cwd?: string; memberCount?: number; attention?: SessionAttention; attentionCursor?: number; attentionLatest?: number;
  lastMessage?: string; description?: string; avatarId?: string; [key: string]: any
}
export interface Message {
  cards?: MessageCard[];
  attachments?: UploadedAttachment[];
  id?: string; sessionId?: string; workTaskId?: string; replyTo?: string | null; replySnapshot?: { id?: string; content?: string; authorName?: string } | null; mentions?: string[];
  role: string; content: string; timestamp?: string | number; authorId?: string; authorName?: string;
  authorUnknown?: boolean; tools?: unknown[]; taskRunId?: string; messageIndex?: number; pending?: boolean;
  [key: string]: any
}
export interface MessageCardSource { documentId: string; title: string; sourceName?: string; version: number; updatedAt: string; contentHash?: string; excerpt?: string; citation?: string; cited?: boolean }
export interface MessageCard {
  version: 1; id: string; kind: 'task_result' | 'task_exception' | 'knowledge'; title: string; summary?: string;
  status?: string; fields?: Array<{label: string; value: string}>; taskId?: string; taskKind?: 'work' | 'schedule';
  sources?: MessageCardSource[];
}
export interface Skill { id: string; name: string; description?: string; enabled?: boolean; scope?: string; groupIds?: string[]; avatarId?: string; [key: string]: any }
export interface UploadedAttachment { id: string; name: string; size: number; mimeType: string; kind: 'image' | 'file'; url: string; downloadUrl: string }
export interface Schedule { id: string; name: string; enabled?: boolean; sessionId?: string; [key: string]: any }
export interface MembersResponse { members: User[]; externalMembers?: Array<{id:string;displayName:string;source:string}>; canRemoveMembers: boolean; canLeave: boolean; leaveBlockedReason?: string; ownerId?: string }
export type View = 'chat' | 'agents' | 'tools' | 'mailbox' | 'skills' | 'schedules' | 'channels' | 'users' | 'audit' | 'events' | 'logs' | 'ocean'
