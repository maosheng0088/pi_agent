<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Bot, ChartColumn, Container, FileText, Headset, ReceiptText, Ship, Tag, Users, WalletCards } from '@lucide/vue'
import { uiArtwork } from '../lib/workspace-assets'
import { avatarSource } from '../lib/avatar-catalog'

const props = withDefaults(defineProps<{ title: string; identity?: string; size?: number; avatarId?: string }>(), { size: 40 })
// The existing support space has a generic title; retain its portrait on rename.
const customerAgentIds = new Set(['01a17c19-6616-72b6-8e2a-86f24b0c032b'])
const appearance = computed(() => {
  const custom = avatarSource(props.avatarId)
  if (custom) return { icon: Bot, src: custom, tone: 'blue', badge: false, portrait: true }
  const name = props.title
  if (customerAgentIds.has(props.identity || '') || /客服|客户|customer|support/i.test(name)) return { icon: Headset, src: uiArtwork.customerAssistant, tone: 'cyan', badge: false, portrait: true }
  if (/提柜|码头|港口|集装箱|pierpass|terminal/i.test(name)) return { icon: Container, src: uiArtwork.database, tone: 'blue', badge: true }
  if (/报价|询价|价格|商务/.test(name)) return { icon: Tag, src: uiArtwork.business, tone: 'violet', badge: false }
  if (/航线|船期|海运|ETA/i.test(name)) return { icon: Ship, src: uiArtwork.business, tone: 'cyan', badge: true }
  if (/应收|收款|付款/.test(name)) return { icon: WalletCards, src: uiArtwork.business, tone: 'orange', badge: true }
  if (/财务|对账|费用|成本/.test(name)) return { icon: ReceiptText, src: uiArtwork.document, tone: 'green', badge: true }
  if (/报关|单证|文档|表格|feishu|gsheet/i.test(name)) return { icon: FileText, src: uiArtwork.document, tone: 'violet', badge: false }
  if (/数据|分析|报表/.test(name)) return { icon: ChartColumn, src: uiArtwork.analytics, tone: 'blue', badge: false }
  if (/团队|人事|协作/.test(name)) return { icon: Users, src: uiArtwork.team, tone: 'blue', badge: false }
  return { icon: Bot, src: uiArtwork.assistant, tone: 'blue', badge: false }
})
const failed = ref(false)
watch(() => appearance.value.src, () => { failed.value = false })
</script>

<template>
  <span :class="['agent-emblem', `emblem-${appearance.tone}`, {'emblem-portrait':appearance.portrait}]" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true">
    <img v-if="!failed" class="emblem-artwork" :src="appearance.src" alt="" @error="failed=true"/>
    <component v-else :is="appearance.icon" :size="Math.round(size * .57)" :stroke-width="1.9"/>
    <span v-if="appearance.badge&&!failed&&size>=36" class="emblem-badge"><component :is="appearance.icon" :size="Math.round(size * .29)" :stroke-width="2"/></span>
  </span>
</template>

<style scoped>
.agent-emblem { position: relative; display: inline-grid; place-items: center; flex-shrink: 0; border-radius: 12px; color: #0877e3; background: linear-gradient(145deg,#f3f8ff,#e4f0ff); box-shadow: inset 0 0 0 1px rgb(27 88 151 / 5%); }
.agent-emblem svg { display: block; }
.emblem-artwork { width: 78%; height: 78%; object-fit: contain; filter: drop-shadow(0 2px 2px rgb(39 70 117 / 9%)); }
.emblem-portrait { overflow:hidden; }
.emblem-portrait .emblem-artwork { width:100%; height:100%; object-fit:cover; filter:none; border-radius:inherit; }
.emblem-badge { position: absolute; right: -2px; bottom: -2px; display: grid; place-items: center; width: 44%; height: 44%; border-radius: 6px; background: #fff; box-shadow: 0 1px 3px rgb(32 52 81 / 12%); }
.emblem-violet { color: #7653da; background: #f0ebff; }
.emblem-cyan { color: #0784a3; background: #e5f5fb; }
.emblem-green { color: #139371; background: #e4f6ef; }
.emblem-orange { color: #cf613d; background: #fff0e7; }
</style>
