<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { Search, ArrowUpRight, MessageSquare } from '@lucide/vue'
import UiModal from './UiModal.vue'
import { api,errorMessage } from '../lib/api'
import { clock } from '../lib/utils'
import type { Message,Session } from '../lib/types'
const props=defineProps<{open:boolean;session:Session}>()
const emit=defineEmits<{close:[];locate:[index:number]}>()
const query=ref(''),results=ref<Message[]>([]),total=ref(0),busy=ref(false),error=ref('')
let request=0,timer:ReturnType<typeof setTimeout>|undefined,controller:AbortController|undefined
function reset(){request++;clearTimeout(timer);controller?.abort();query.value='';results.value=[];total.value=0;error.value='';busy.value=false}
watch([()=>props.open,()=>props.session.id],reset)
watch(query,()=>{request++;clearTimeout(timer);controller?.abort();results.value=[];total.value=0;error.value='';busy.value=false;timer=setTimeout(()=>search(),300)})
onBeforeUnmount(reset)
async function search(more=false){
  clearTimeout(timer);controller?.abort();const text=query.value.trim(),token=++request
  if(!props.open||!text){results.value=[];total.value=0;busy.value=false;return}
  if(text.length>200){error.value='关键词不能超过 200 个字符。';return}
  busy.value=true;error.value='';controller=new AbortController()
  if(!more)results.value=[]
  try{const params=new URLSearchParams({q:text,limit:'30',offset:String(results.value.length)});const data=await api<{results:Message[];total:number}>(`/api/sessions/${encodeURIComponent(props.session.id)}/search?${params}`,{signal:controller.signal});if(token===request&&props.open){results.value.push(...data.results);total.value=data.total}}catch(e){if(token===request&&!(e instanceof Error&&e.name==='AbortError'))error.value=errorMessage(e)}finally{if(token===request)busy.value=false}
}
function highlight(text:string){const needle=query.value.trim();if(!needle)return[{text,hit:false}];const parts:Array<{text:string;hit:boolean}>=[];let start=0,index=0;while((index=text.toLowerCase().indexOf(needle.toLowerCase(),start))>=0){parts.push({text:text.slice(start,index),hit:false},{text:text.slice(index,index+needle.length),hit:true});start=index+needle.length}parts.push({text:text.slice(start),hit:false});return parts}
</script>
<template>
  <UiModal :open="open" title="查找聊天记录" :description="`仅搜索「${session.title}」的协作记录。`" wide @close="emit('close')">
    <form class="history-search-bar" @submit.prevent="search()"><Search :size="18"/><label class="sr-only" for="history-query">聊天记录关键词</label><input id="history-query" v-model="query" type="search" placeholder="输入关键词，查找消息或任务结果" maxlength="200" autofocus><button class="btn btn-primary" :disabled="busy||!query.trim()">查找</button></form>
    <div v-if="error" class="error-box" role="alert">{{error}}</div>
    <div v-if="!query.trim()" class="empty-state"><MessageSquare/>输入关键词，找到之前的消息与结果。</div>
    <div v-else><div class="search-summary" role="status">{{busy?'正在查找…':`找到 ${total} 条相关消息`}}</div><div class="search-results"><button v-for="item in results" :key="item.messageIndex" class="search-result" @click="emit('locate',item.messageIndex!);emit('close')"><span class="search-result-meta"><strong>{{item.role==='assistant'?session.title:item.authorName||'历史成员'}}</strong><time>{{clock(item.timestamp,true)}}</time></span><span class="search-result-text"><template v-for="(part,index) in highlight(item.snippet||item.content)" :key="index"><mark v-if="part.hit">{{part.text}}</mark><template v-else>{{part.text}}</template></template></span><span class="search-result-link">定位到消息<ArrowUpRight :size="12"/></span></button><div v-if="!busy&&!results.length" class="empty-state">没有找到匹配记录，试试其他关键词。</div></div><button v-if="results.length<total" class="btn search-more" :disabled="busy" @click="search(true)">加载更多 · {{results.length}} / {{total}}</button></div>
  </UiModal>
</template>
<style scoped>
.history-search-bar { display:flex;align-items:center;gap:10px;padding:6px 6px 6px 12px;border:1px solid #e5eaf2;border-radius:11px;background:#fafbfe; }.history-search-bar>svg { color:#64748b;flex-shrink:0; }.history-search-bar input { min-width:0;width:100%;outline:0;border:0;background:none;font-size:13px; }.history-search-bar:focus-within { border-color:#a9c0f3; }.history-search-bar .btn { min-height:36px;padding:7px 16px; }.search-summary { color:#64748b;font-size:12px;margin:8px 0 14px; }.search-results { max-height:50dvh;overflow-y:auto; }.search-result { width:100%;text-align:left;padding:16px 0;border:0;background:white;border-bottom:1px solid #edf0f6;display:flex;flex-direction:column;gap:9px; }.search-result:hover { background:#fafcff; }.search-result-meta { display:flex;gap:16px;align-items:center;justify-content:space-between;font-size:12px; }.search-result-meta strong { font-weight:500;color:#52637e; }.search-result-meta time { color:#64748b;font-size:12px; }.search-result-text { font-size:13px;line-height:1.8;color:#62718a;overflow-wrap:anywhere;white-space:pre-wrap; }.search-result-text mark { color:#2256b5;background:#e4edff;border-radius:3px; }.search-result-link { display:flex;gap:3px;align-items:center;color:#64748b;font-size:12px; }.search-more { width:100%;margin-top:16px; }
</style>
