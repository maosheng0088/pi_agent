<script setup lang="ts">
import { useId } from 'vue'
import { Check, Sparkles } from '@lucide/vue'
import { avatarOptions } from '../lib/avatar-catalog'

withDefaults(defineProps<{ modelValue: string; disabled?: boolean; label?: string }>(), { label:'头像', disabled:false })
const emit = defineEmits<{ 'update:modelValue': [value:string] }>()
const groupName = `avatar-choice-${useId()}`
</script>

<template>
  <fieldset class="avatar-picker" :disabled="disabled">
    <legend>{{ label }}</legend>
    <p class="avatar-picker-hint">选择一张头像，或使用自动推荐。</p>
    <div class="avatar-choice-grid">
      <label class="avatar-choice" :class="{'is-selected':!modelValue}">
        <input type="radio" :name="groupName" value="" :checked="!modelValue" @change="emit('update:modelValue','')"/>
        <span class="avatar-auto"><Sparkles :size="23" aria-hidden="true"/></span>
        <span class="avatar-choice-name">自动推荐</span><Check v-if="!modelValue" class="avatar-choice-check" :size="13" aria-hidden="true"/>
      </label>
      <label v-for="option in avatarOptions" :key="option.id" class="avatar-choice" :class="{'is-selected':modelValue===option.id}">
        <input type="radio" :name="groupName" :value="option.id" :checked="modelValue===option.id" @change="emit('update:modelValue',option.id)"/>
        <img :src="option.src" alt="" width="44" height="44" loading="lazy" decoding="async"/>
        <span class="avatar-choice-name">{{ option.label }}</span><Check v-if="modelValue===option.id" class="avatar-choice-check" :size="13" aria-hidden="true"/>
      </label>
    </div>
  </fieldset>
</template>

<style scoped>
.avatar-picker { min-width:0; margin:20px 0 0; padding:0; border:0; }
.avatar-picker legend { padding:0; color:#34465f; font-size:13px; font-weight:550; line-height:1.7; }
.avatar-picker-hint { margin:5px 0 12px; color:#64748b; font-size:12px; line-height:1.7; }
.avatar-choice-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:7px; }
.avatar-choice { position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; min-width:0; min-height:80px; padding:9px 3px 7px; border:1px solid #e5eaf2; border-radius:9px; background:#fff; color:#56657b; cursor:pointer; }
.avatar-choice input { position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; }
.avatar-choice img,.avatar-auto { display:grid; place-items:center; width:44px; height:44px; flex-shrink:0; border-radius:11px; object-fit:cover; }
.avatar-auto { background:#eef4ff; color:#3972c9; }
.avatar-choice-name { max-width:100%; color:inherit; font-size:12px; line-height:1.6; white-space:nowrap; }
.avatar-choice:hover { border-color:#b8cbf0; background:#f8faff; }
.avatar-choice.is-selected { border-color:#4f81dd; background:#eef4ff; color:#245cb9; box-shadow:inset 0 0 0 1px #4f81dd; }
.avatar-choice:focus-within { outline:2px solid #245bdb; outline-offset:2px; }
.avatar-choice-check { position:absolute; top:4px; right:4px; padding:1px; border-radius:50%; background:#245bdb; color:#fff; }
.avatar-picker:disabled .avatar-choice { cursor:default; opacity:.65; }.avatar-picker:disabled input { cursor:default; }
@media(max-width:380px) { .avatar-choice-grid { gap:5px; }.avatar-choice { min-height:74px; }.avatar-choice img,.avatar-auto { width:38px; height:38px; } }
</style>
