<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { initials } from '../lib/utils'
import { userAvatarSource } from '../lib/user-avatars'

const props = defineProps<{ name: string; identity?: string; external?: boolean }>()
const source = computed(() => userAvatarSource(props.identity, props.external))
const failed = ref(false)
watch(source, () => { failed.value = false })
</script>

<template>
  <span class="user-portrait" aria-hidden="true">
    <img v-if="source && !failed" class="user-portrait-image" :src="source" alt="" width="384" height="384" loading="lazy" decoding="async" @error="failed=true"/>
    <template v-else>{{ initials(name) }}</template>
  </span>
</template>

<style scoped>
.user-portrait { position:relative; display:inline-grid; place-items:center; flex-shrink:0; overflow:hidden; vertical-align:middle; }
.user-portrait-image { position:absolute; inset:0; display:block; width:100%; height:100%; border-radius:inherit; object-fit:cover; }
</style>
