<script setup lang="ts">
import { computed } from 'vue'
import { fileIconSource } from '../lib/workspace-assets'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 32 })
const source = computed(() => fileIconSource(props.name))
</script>

<template>
  <img class="file-icon" :src="source" :width="size" :height="size" alt="" aria-hidden="true" draggable="false" decoding="async">
</template>

<style scoped>
.file-icon { display:block; flex:none; object-fit:contain; }
</style>
