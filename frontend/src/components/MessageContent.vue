<script setup lang="ts">
import { computed } from 'vue'
import FileIcon from './FileIcon.vue'
import AttachmentPreview from './AttachmentPreview.vue'
import { messageTokens } from '../lib/message-links'
const props = defineProps<{content:string;plain?:boolean}>()
type Segment = {type:'text'|'code';text:string;language?:string}
const segments = computed<Segment[]>(() => {
  if (props.plain) return [{type:'text',text:props.content}]
  return props.content.split(/(^```[^\n]*\n[\s\S]*?(?:\n```\s*(?:\n|$)|$))/m).filter(Boolean).map(text => text.startsWith('```') ? {type:'code',language:text.split('\n')[0].slice(3).trim(),text:text.replace(/^```[^\n]*\n/,'').replace(/\n```\s*$/,'')} : {type:'text',text})
})
</script>
<template>
  <div v-if="plain" class="message-prose whitespace-pre-wrap">{{ content }}</div>
  <div v-else class="message-prose">
    <template v-for="(segment,index) in segments" :key="index">
      <div v-if="segment.type==='code'" class="code-block"><div v-if="segment.language" class="code-language">{{ segment.language }}</div><pre><code>{{ segment.text }}</code></pre></div>
      <template v-else v-for="(line,lineIndex) in segment.text.split('\n')" :key="lineIndex">
        <hr v-if="/^\s*---+\s*$/.test(line)">
        <component :is="/^#{1,4}\s/.test(line)?'h4':'p'" v-else :class="{'bullet-line':/^\s*[-*]\s/.test(line)}">
          <template v-for="(token,tokenIndex) in messageTokens(line.replace(/^#{1,4}\s+/,''))" :key="tokenIndex">
            <code v-if="token.kind==='code'">{{ token.text }}</code>
            <strong v-else-if="token.kind==='strong'">{{ token.text }}</strong>
            <AttachmentPreview v-else-if="token.kind==='attachment'" :attachment="token.attachment" :label="token.text"/>
            <a v-else-if="token.kind==='link' && token.file" class="message-file-link" :href="token.href" target="_blank" rel="noreferrer noopener" :aria-label="`打开文件：${token.text}（新窗口）`">
              <span class="message-file-icon"><FileIcon :name="token.file.name" :size="34" /></span>
              <span class="message-file-description"><span class="message-file-title">{{ token.text }}</span><span class="message-file-meta">{{ token.file.name }} · {{ token.file.typeLabel }} · {{ token.file.hostname }}</span></span>
              <span class="message-file-open" aria-hidden="true">↗</span>
            </a>
            <a v-else-if="token.kind==='link'" class="message-web-link" :href="token.href" target="_blank" rel="noreferrer noopener">{{ token.text }}</a>
            <template v-else>{{ token.text }}</template>
          </template>
        </component>
      </template>
    </template>
  </div>
</template>
<style scoped>
.message-prose { overflow-wrap:anywhere; font-size:14px; line-height:1.85; }
p { margin:0; min-height:.7em; white-space:pre-wrap; }
h4 { font-size:15px; font-weight:650; margin:12px 0 6px; }
h4:first-child { margin-top:0; }
strong { font-weight:650; }
code { font-size:12px; font-family:"Cascadia Code",Consolas,monospace; background:#dbe2ee66; border-radius:4px; padding:2px 5px; }
.code-block { margin:10px 0; background:#fff; border:1px solid #e3e8f0; border-radius:8px; overflow:hidden; }
.code-language { padding:5px 12px; background:#f6f8fc; font-size:11px; color:#7c8ba0; border-bottom:1px solid #edf0f5; }
pre { overflow-x:auto; padding:12px; margin:0; line-height:1.7; max-width:100%; }
pre code { padding:0; background:none; }
hr { border:0; border-top:1px solid #dce3ee; margin:14px 0; }
.message-web-link { color:var(--brand,#356df3); text-decoration:underline; text-underline-offset:3px; }
.message-file-link { display:flex; align-items:center; gap:11px; width:min(100%,360px); max-width:100%; box-sizing:border-box; margin:8px 0; padding:12px 13px; border:1px solid #dce5f0; border-radius:10px; background:#fff; color:#243852; text-decoration:none; white-space:normal; box-shadow:0 2px 6px #1d386108; transition:border-color .16s ease,box-shadow .16s ease; }
.message-file-link:hover { border-color:#9db9ec; box-shadow:0 3px 10px #356df312; }
.message-file-link:focus-visible,.message-web-link:focus-visible { outline:3px solid #8cb3ff; outline-offset:3px; }
.message-file-icon { display:grid; place-items:center; flex:none; width:42px; height:46px; }
.message-file-description { display:flex; flex-direction:column; gap:3px; min-width:0; flex:1; }
.message-file-title { font-size:13px; line-height:1.6; font-weight:600; overflow-wrap:anywhere; }
.message-file-meta { font-size:12px; line-height:1.6; color:#65778e; overflow-wrap:anywhere; }
.message-file-open { flex:none; color:#7b8ca3; font-size:18px; }
@media (prefers-reduced-motion:reduce) { .message-file-link { transition:none; } }
</style>
