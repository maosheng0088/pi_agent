<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Cable } from '@lucide/vue'
import { channelIdentity } from '../lib/workspace-assets'

const props = withDefaults(defineProps<{ type: string; size?: number }>(), { size: 32 })
const identity = computed(() => channelIdentity(props.type))
const imageFailed = ref(false)
watch(() => identity.value.src, () => { imageFailed.value = false })
</script>

<template>
  <span class="channel-mark" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true">
    <img v-if="identity.src && !imageFailed" :src="identity.src" :width="size" :height="size" alt="" decoding="async" @error="imageFailed = true"/>
    <Cable v-else :size="Math.max(14, Math.round(size * .55))" :stroke-width="1.7"/>
  </span>
</template>

<style scoped>
.channel-mark { display: inline-grid; place-items: center; flex-shrink: 0; overflow: hidden; border: 1px solid #e9edf3; border-radius: 24%; background: #fff; color: #65748b; }
.channel-mark img { display: block; width: 100%; height: 100%; object-fit: contain; }
</style>
