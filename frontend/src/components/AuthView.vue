<script setup lang="ts">
import { ref } from 'vue'
import { ArrowRight, Eye, EyeOff, Layers, ShieldCheck, Users } from '@lucide/vue'
import { useWorkspaceStore } from '../stores/workspace'
import { uiArtwork } from '../lib/workspace-assets'
const store=useWorkspaceStore()
const username=ref(''),password=ref(''),confirm=ref(''),displayName=ref(''),busy=ref(false),visible=ref(false)
async function submit() {
  if (busy.value) return
  if(store.setupRequired && password.value!==confirm.value) { store.authError='两次输入的密码不一致。';return }
  busy.value=true
  try { await store.authenticate(username.value,password.value,displayName.value) } catch {} finally { password.value='';confirm.value='';busy.value=false }
}
</script>
<template>
  <main class="auth-layout">
    <section class="auth-intro" aria-label="Pi 智能体工作台">
      <div class="auth-logo"><span class="pi-mark">π</span><strong>Pi <span>Workspace</span></strong></div>
      <div class="intro-copy"><span class="intro-label">YOUR TEAM. SUPERCHARGED.</span><h1>让专业能力，<br>成为团队的日常。</h1><p>把技能交给智能体，把时间留给业务。<br>和同事一起，完成每一项重要的工作。</p></div>
      <div class="intro-art" aria-hidden="true"><img :src="uiArtwork.collaboration" alt="" width="260" height="220" decoding="async"></div>
      <div class="intro-footer"><span><Layers :size="15"/> 专属技能</span><span><Users :size="15"/> 团队协作</span><span><ShieldCheck :size="15"/> 成员权限</span></div>
    </section>
    <section class="auth-form-section">
      <div class="auth-company">{{ store.workspace?.name || '企业智能体工作空间' }}</div>
      <div class="auth-form-wrap">
        <span class="auth-welcome">{{ store.setupRequired?'GET STARTED':'WELCOME BACK' }}</span>
        <h2>{{ store.booting?'正在连接工作空间':store.setupRequired?'创建管理员账户':'欢迎回到工作台' }}</h2>
        <p>{{ store.booting?'正在确认你的登录状态…':store.setupRequired?'创建首个管理员，开始搭建团队的智能体。':'登录后，进入你的专业智能体协作空间。' }}</p>
        <div v-if="store.authError" class="error-box" role="alert">{{ store.authError }}</div>
        <div v-if="store.booting" class="auth-loading"><span class="loading-dot"></span>正在连接…</div>
        <form v-else-if="!store.setupRequired || store.setupAllowed" @submit.prevent="submit">
          <div class="field"><label for="auth-username">账号</label><input id="auth-username" v-model="username" class="input" autocomplete="username" required minlength="3" maxlength="48" placeholder="输入你的工作账号"></div>
          <div v-if="store.setupRequired" class="field"><label for="auth-display-name">姓名</label><input id="auth-display-name" v-model="displayName" class="input" autocomplete="name" required maxlength="80" placeholder="你的姓名"></div>
          <div class="field"><label for="auth-password">密码</label><div class="password-input"><input id="auth-password" v-model="password" class="input" :type="visible?'text':'password'" :autocomplete="store.setupRequired?'new-password':'current-password'" required :minlength="store.setupRequired?8:1" maxlength="128" placeholder="输入你的密码"><button class="icon-btn" type="button" :aria-label="visible?'隐藏密码':'显示密码'" :aria-pressed="visible" @click="visible=!visible"><EyeOff v-if="visible" :size="17"/><Eye v-else :size="17"/></button></div></div>
          <div v-if="store.setupRequired" class="field"><label for="auth-confirm">确认密码</label><input id="auth-confirm" v-model="confirm" class="input" type="password" autocomplete="new-password" required maxlength="128"></div>
          <div class="login-note"><ShieldCheck :size="14"/><span>{{ store.setupRequired?'请使用至少 8 位密码':'账户由管理员统一创建与管理' }}</span></div>
          <button class="btn btn-primary login-button" type="submit" :disabled="busy">{{ busy?'正在进入…':store.setupRequired?'创建并进入工作台':'进入工作台' }}<ArrowRight :size="17" /></button>
        </form>
        <p v-else class="error-box">请在服务所在电脑通过 localhost 创建首个管理员账户。</p>
        <button v-if="!store.online" class="reconnect-link" @click="store.initialize">重新连接服务</button>
        <p class="auth-help">{{ store.setupRequired?'管理员可以创建智能体、分配技能和邀请成员。':'没有账号或忘记密码？请联系管理员。' }}</p>
      </div>
      <footer>Pi Workspace <span>专注业务，协作更进一步。</span></footer>
    </section>
  </main>
</template>
<style scoped>
.auth-layout { min-height:100dvh; display:grid; grid-template-columns:1fr 1fr; background:white; }
.auth-intro { background:#eef3fc; padding:46px clamp(32px,6vw,100px); display:flex; flex-direction:column; position:relative; overflow:hidden; }
.auth-intro::before { content:''; position:absolute; width:540px;height:540px;border:1px solid #dce6f7;border-radius:50%;left:-300px;bottom:-190px;pointer-events:none; }
.auth-logo { display:flex;align-items:center;gap:12px; font-size:21px;letter-spacing:-.7px; }
.auth-logo strong { font-weight:650; }.auth-logo strong span { font-weight:400;color:#64748b; }
.pi-mark { width:40px;height:40px;display:grid;place-items:center;background:#2563eb;border-radius:12px;color:white;font:bold 34px Georgia; box-shadow:0 6px 14px #2563eb20; }
.intro-copy { margin-top:clamp(70px,12vh,130px); }.intro-label { font-size:12px;letter-spacing:2.8px;font-weight:600;color:#64748b; }
.intro-copy h1 { font-size:clamp(30px,3.5vw,48px);line-height:1.5;letter-spacing:-1.8px;font-weight:650;margin:18px 0 20px;color:#1e3556; }.intro-copy>p { font-size:14px;line-height:2;color:#64748b; }
.intro-art { display:flex; align-items:center; justify-content:center; width:min(100%,360px); margin-top:26px; }.intro-art img { display:block; width:min(100%,260px); height:220px; object-fit:contain; }


.intro-footer { display:flex;gap:24px;font-size:12px;color:#64748b;margin-top:auto;padding-top:55px;z-index:1; }.intro-footer>span { display:flex;align-items:center;gap:7px; }
.auth-form-section { display:flex;flex-direction:column;padding:38px 48px; }.auth-company { font-size:12px;color:#64748b;text-align:right; }.auth-form-wrap { width:min(360px,100%);margin:auto; padding:50px 0; }.auth-welcome { font-size:12px;color:#64748b;letter-spacing:2px;font-weight:600; }.auth-form-wrap h2 { font-size:27px;letter-spacing:-1px;font-weight:650;margin:13px 0 12px; }.auth-form-wrap>p { font-size:12px;color:#64748b;line-height:1.8;margin:0 0 35px; }.field { margin-bottom:21px; }.field>label { font-size:12px; }.input { min-height:46px;background:#fcfdff;font-size:13px; }.password-input { position:relative; }.password-input input { padding-right:44px; }.password-input button { position:absolute;right:3px;top:3px; }.login-note { display:flex;gap:6px;align-items:center;color:#64748b;font-size:12px; }.login-button { width:100%;margin-top:26px;min-height:46px;justify-content:space-between;padding:12px 17px; }.auth-form-wrap .auth-help { margin:24px 0 0;text-align:center;color:#64748b;font-size:12px; }.auth-form-section footer { display:flex;justify-content:space-between;font-size:12px;color:#64748b; }.auth-loading { display:flex;gap:10px;align-items:center;font-size:13px;color:#789; }.reconnect-link { background:none;border:0;color:#2563eb;font-size:12px;padding:12px 0; }
@media(max-width:900px) { .auth-intro { padding:35px; }.intro-copy h1 { font-size:34px; }.intro-footer { gap:13px; }.auth-form-section { padding:30px; } }
@media(max-width:650px) { .auth-layout { grid-template-columns:1fr; }.auth-intro { padding:24px; }.intro-copy,.intro-art,.intro-footer { display:none; }.auth-logo { font-size:18px; }.pi-mark { width:34px;height:34px;font-size:29px; }.auth-form-section { padding:22px;min-height:calc(100dvh - 82px); }.auth-company { font-size:12px; }.auth-form-wrap { padding:40px 0; }.auth-form-section footer span { display:none; } }
</style>
