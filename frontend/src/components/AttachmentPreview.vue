<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Download, Expand, ExternalLink } from '@lucide/vue'
import type { MessageAttachment } from '../lib/message-links'
import FileIcon from './FileIcon.vue'
import UiModal from './UiModal.vue'

const props = defineProps<{ attachment: MessageAttachment; label: string }>()
const imageFailed = ref(false), imageLoading = ref(true), previewOpen = ref(false), previewFailed = ref(false)
const displayLabel = computed(() => props.label.trim() || props.attachment.name)
watch(() => props.attachment.href, () => {
  imageFailed.value = false; imageLoading.value = true; previewOpen.value = false; previewFailed.value = false
})
function openPreview() { previewFailed.value = false; previewOpen.value = true }
function thumbnailFailed() { imageLoading.value = false; imageFailed.value = true; previewOpen.value = false }
</script>

<template>
  <span class="message-attachment">
    <template v-if="attachment.image && !imageFailed">
      <span class="message-image-card">
        <button type="button" class="message-image-preview" :aria-label="`放大图片：${displayLabel}`" aria-haspopup="dialog" @click="openPreview">
          <span v-if="imageLoading" class="image-loading" role="status">正在加载图片…</span>
          <img class="message-attachment-image" :src="attachment.href" :alt="displayLabel" loading="lazy" decoding="async" @load="imageLoading = false" @error="thumbnailFailed"/>
          <span class="image-expand" aria-hidden="true"><Expand :size="15"/></span>
        </button>
        <span class="image-card-caption"><span><strong>{{ attachment.name }}</strong><small>图片附件</small></span><a class="attachment-download" :href="attachment.downloadHref" :download="attachment.name" :aria-label="`下载图片：${attachment.name}`"><Download :size="15" aria-hidden="true"/><span>下载</span></a></span>
      </span>
    </template>
    <template v-else>
      <span v-if="attachment.image && imageFailed" class="attachment-unavailable" role="status">图片暂时无法预览，可打开或下载文件。</span>
      <span class="message-attachment-card">
        <a class="attachment-open" :href="attachment.href" target="_blank" rel="noreferrer noopener" :aria-label="`打开文件：${attachment.name}（新窗口）`">
          <FileIcon :name="attachment.name" :size="34"/>
          <span class="attachment-description"><strong>{{ displayLabel }}</strong><small>{{ attachment.name }} · {{ attachment.typeLabel }}</small></span>
          <ExternalLink :size="14" aria-hidden="true"/>
        </a>
        <a class="attachment-download" :href="attachment.downloadHref" :download="attachment.name" :aria-label="`下载文件：${attachment.name}`"><Download :size="15" aria-hidden="true"/><span>下载</span></a>
      </span>
    </template>
    <UiModal :open="previewOpen" :title="attachment.name" description="图片预览" wide @close="previewOpen = false">
      <p v-if="previewFailed" class="preview-unavailable" role="status">图片暂时无法打开，可尝试下载查看。</p>
      <img v-else class="attachment-preview-image" :src="attachment.href" :alt="displayLabel" decoding="async" @error="previewFailed = true"/>
      <div class="preview-actions"><a class="btn btn-primary" :href="attachment.downloadHref" :download="attachment.name"><Download :size="16"/>下载图片</a><button class="btn" type="button" @click="previewOpen = false">关闭</button></div>
    </UiModal>
  </span>
</template>

<style scoped>
.message-attachment { display:block; width:min(100%,380px); max-width:100%; margin:8px 0; color:#243852; white-space:normal; }
.message-image-card { display:block; max-width:100%; overflow:hidden; border:1px solid #dce5f0; border-radius:9px; background:#fff; }
.message-image-preview { position:relative; display:grid; place-items:center; width:100%; max-width:100%; min-height:90px; padding:4px; overflow:hidden; border:0; border-bottom:1px solid #e9edf3; background:#f6f8fb; cursor:zoom-in; }
.message-attachment-image { display:block; max-width:100%; max-height:260px; width:auto; height:auto; object-fit:contain; }
.image-loading { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); color:#627188; font-size:12px; }
.image-expand { position:absolute; right:9px; bottom:9px; display:grid; place-items:center; width:28px; height:28px; border:1px solid #e1e7f0; border-radius:5px; background:#fffffff0; color:#526d90; }
.image-card-caption { display:flex; align-items:center; gap:10px; padding:10px 12px; }
.image-card-caption>span { flex:1; min-width:0; }
.image-card-caption strong,.attachment-description strong { display:block; color:#243852; font-size:13px; font-weight:550; line-height:1.6; overflow-wrap:anywhere; }
.image-card-caption small,.attachment-description small { display:block; margin-top:2px; color:#627188; font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
.message-attachment-card { display:flex; align-items:center; gap:6px; max-width:100%; padding:10px 9px 10px 12px; border:1px solid #dce5f0; border-radius:9px; background:#fff; }
.attachment-open { display:flex; align-items:center; flex:1; gap:10px; min-width:0; color:#243852; text-decoration:none; }
.attachment-open>svg,.attachment-open>:first-child { flex-shrink:0; }
.attachment-description { display:block; flex:1; min-width:0; }
.attachment-download { display:inline-flex; align-items:center; flex-shrink:0; gap:4px; min-height:32px; padding:5px 7px; border-radius:5px; color:#0868d3; font-size:12px; line-height:1.6; text-decoration:none; }
.attachment-download:hover { background:#edf5ff; }
.attachment-open:hover strong { color:#0868d3; }
.attachment-download:focus-visible,.attachment-open:focus-visible,.message-image-preview:focus-visible { outline:3px solid #8cb3ff; outline-offset:2px; }
.attachment-unavailable { display:block; margin:0 0 7px; color:#627188; font-size:12px; line-height:1.6; }
.attachment-preview-image { display:block; max-width:100%; max-height:64dvh; margin:auto; object-fit:contain; }
.preview-unavailable { margin:0; color:#627188; font-size:14px; line-height:1.8; }
.preview-actions { display:flex; justify-content:flex-end; gap:9px; }
@media(max-width:450px) { .message-attachment-card { gap:3px;padding:9px; }.attachment-open { gap:7px; }.attachment-download { padding:5px; }.attachment-open>svg { display:none; }.message-attachment-image { max-height:220px; } }
</style>
