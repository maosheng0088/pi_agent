<script setup lang="ts">
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
withDefaults(defineProps<{open:boolean;title:string;description?:string;wide?:boolean}>(), { description:'', wide:false })
const emit = defineEmits<{close:[]}>()
</script>
<template>
  <Dialog :open="open" @update:open="value => { if (!value) emit('close') }">
    <DialogContent :class="['pi-modal', { 'pi-modal-wide':wide }]">
      <DialogHeader>
        <DialogTitle class="text-xl font-semibold tracking-tight">{{ title }}</DialogTitle>
        <DialogDescription :class="description ? 'text-[13px] leading-relaxed text-slate-500' : 'sr-only'">{{ description || title }}</DialogDescription>
      </DialogHeader>
      <slot />
    </DialogContent>
  </Dialog>
</template>
<style>
.pi-modal { max-height:90dvh; overflow-y:auto; padding:28px; border-radius:18px; gap:22px; }
.pi-modal-wide { max-width:740px !important; }
@media(max-width:600px) { .pi-modal { padding:22px; max-width:calc(100vw - 24px) !important; } }
</style>
