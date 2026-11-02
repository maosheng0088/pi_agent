<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { X } from '@lucide/vue'

const props = defineProps<{ open: boolean; title: string; description?: string; busy?: boolean; wide?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const titleId = useId()
watch(() => props.open, async open => {
  await nextTick()
  if (open && !dialog.value?.open) dialog.value?.showModal()
  else if (!open && dialog.value?.open) dialog.value.close()
}, { immediate: true })
function requestClose() { if (!props.busy) emit('close') }
onBeforeUnmount(() => dialog.value?.close())
</script>

<template>
  <dialog ref="dialog" class="automation-dialog" :class="{ wide }" :aria-labelledby="titleId" @cancel.prevent="requestClose" @close="props.open && requestClose()">
    <header class="modal-heading"><div><h2 :id="titleId">{{ title }}</h2><p v-if="description">{{ description }}</p></div><button type="button" class="modal-close" aria-label="关闭窗口" :disabled="busy" @click="requestClose"><X :size="20" /></button></header>
    <div class="modal-content"><slot /></div>
    <footer v-if="$slots.footer" class="modal-actions"><slot name="footer" /></footer>
  </dialog>
</template>

<style scoped>
.automation-dialog{width:min(580px,calc(100vw - 32px));max-height:calc(100dvh - 64px);margin:auto;border:1px solid var(--border);border-radius:18px;padding:0;color:var(--foreground);background:var(--card);box-shadow:0 24px 80px #0f172a26;overflow:auto}.automation-dialog.wide{width:min(760px,calc(100vw - 32px))}.automation-dialog::backdrop{background:#172b4d66;backdrop-filter:blur(3px)}.modal-heading{padding:25px 26px 20px;display:flex;gap:20px;justify-content:space-between;border-bottom:1px solid var(--border)}h2{font-size:19px;font-weight:650;margin:0;letter-spacing:-.4px}.modal-heading p{font-size:13px;color:#68758a;line-height:1.7;margin:7px 0 0}.modal-close{flex-shrink:0;display:grid;place-items:center;width:36px;height:36px;border:0;border-radius:8px;background:#f3f6fa;color:#728096}.modal-content{padding:24px 26px}.modal-actions{padding:18px 26px;border-top:1px solid var(--border);display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}@media(max-width:600px){.automation-dialog{max-height:calc(100dvh - 24px)}.modal-heading,.modal-content,.modal-actions{padding:18px}}
</style>
