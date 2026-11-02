<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { Search, Users } from '@lucide/vue'
import type { Session } from '../lib/types'
const props = defineProps<{ scope: string; groupIds: string[]; sessions: Session[] }>()
const emit = defineEmits<{ 'update:scope': [value: string]; 'update:groupIds': [value: string[]] }>()
const id = useId(), query = ref('')
const choices = computed(() => {
  const known = props.sessions.map(group => ({ id: group.id, title: group.title || '未命名智能体', accessible: true }))
  for (const selected of props.groupIds) if (!known.some(group => group.id === selected)) known.push({ id: selected, title: '已授权智能体（目前不可访问）', accessible: false })
  return known.filter(group => group.title.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()))
})
function toggle(id: string, selected: boolean) { emit('update:groupIds', selected ? [...new Set([...props.groupIds, id])] : props.groupIds.filter(value => value !== id)) }
</script>

<template>
  <div class="field"><label :for="`${id}-scope`">共享范围</label><select :id="`${id}-scope`" class="input" :value="scope" @change="emit('update:scope', ($event.target as HTMLSelectElement).value)"><option value="all">全部智能体共享</option><option value="groups">仅指定智能体</option></select><small>{{ scope === 'all' ? '包含当前及今后创建的智能体，员工仍需加入相应业务空间才能使用。' : '仅授权智能体的协作成员及其定时任务可以使用此技能。' }}</small></div>
  <div v-if="scope === 'groups'" class="scope-list"><div class="scope-search"><Search :size="16" /><input :id="`${id}-search`" v-model="query" type="search" placeholder="搜索智能体" aria-label="搜索可授权的智能体" /></div><p class="selection-count" aria-live="polite">已选择 {{ groupIds.length }} 个智能体</p><div class="scope-choices"><label v-for="group in choices" :key="group.id" class="scope-choice"><input type="checkbox" :checked="groupIds.includes(group.id)" @change="toggle(group.id, ($event.target as HTMLInputElement).checked)" /><span><strong>{{ group.title }}</strong><small v-if="!group.accessible">历史授权，可保留或取消。</small></span></label><div v-if="!choices.length" class="scope-empty"><Users :size="22" /><span>{{ query ? '没有匹配的智能体' : '请先创建或加入智能体业务空间' }}</span></div></div><small class="scope-note">只展示你已加入的智能体；不可访问的历史授权会隐藏名称。</small></div>
</template>

<style scoped>
.scope-list{border:1px solid var(--border);border-radius:11px;padding:14px}.scope-search{display:flex;align-items:center;gap:8px;background:#f6f8fb;padding:10px 12px;border-radius:8px;color:#8994a6}.scope-search input{background:transparent;border:0;width:100%;font-size:13px;min-width:0}.selection-count{font-size:12px;color:#66758c;margin:12px 0 7px}.scope-choices{max-height:220px;overflow:auto}.scope-choice{display:flex;gap:11px;align-items:center;min-height:46px;padding:9px 6px;cursor:pointer;border-radius:7px}.scope-choice:hover{background:#f5f8fd}.scope-choice strong{font-size:13px;font-weight:500;display:block}.scope-choice small,.scope-note{display:block;color:#718096;font-size:12px;line-height:1.6}.scope-note{margin-top:11px}.scope-empty{padding:24px 8px;display:flex;align-items:center;justify-content:center;gap:10px;color:#78869c;font-size:13px}
</style>
