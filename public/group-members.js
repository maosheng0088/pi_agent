export function createGroupMembers({ $, api, state, node, toast, ensureSession, onLeft = () => {} }) {
  let people = [], members = [], externalMembers = [], selected = new Set(), request = 0, saving = false;
  const dialog = $('group-members-dialog');
  let panelKey='',panelMembers=[],panelRequest=0,panelLoaded=0,panelBusy=false,panelRevision;
  const removeDialog=$('remove-group-member-dialog');
  const leaveDialog=$('leave-group-dialog');
  let canLeave=false,leaveBlockedReason='',leaveTarget=null,leaveBusy=false,leaveRequest=0;
  let canRemoveMembers=false,groupOwnerId=null,removeTarget=null,removeBusy=false,removeRequest=0;
  const removable=member=>canRemoveMembers && member.id!==state.user?.id && member.id!==groupOwnerId;
  const externalSource=member=>member.source==='wecom' ? '企业微信' : '微信';
  function removeButton(member) {
    const groupId=state.session?.id;
    const button=node('button','group-remove-member','移除');button.type='button';button.setAttribute('aria-label',`移除群成员 ${member.displayName}`);
    button.addEventListener('click',()=>{
      if(!removable(member) || !state.session || state.session.id!==groupId)return;
      removeTarget={...member,sessionId:state.session.id,userId:state.user.id,epoch:state.identityEpoch};removeBusy=false;removeRequest++;
      $('remove-group-member-name').textContent=member.displayName;
      $('remove-group-member-group').textContent=state.session.title;
      $('remove-group-member-error').hidden=true;$('confirm-remove-member').disabled=false;$('confirm-remove-member').textContent='确认移除';
      removeDialog.showModal();$('cancel-remove-member').focus();
    });
    return button;
  }
  function applyMembers(result) {
    panelMembers=result.members;members=result.members;externalMembers=result.externalMembers || [];
    canRemoveMembers=result.canRemoveMembers===true;groupOwnerId=result.ownerId || state.session?.ownerId || null;
    canLeave=result.canLeave===true;leaveBlockedReason=result.leaveBlockedReason || '';
    panelLoaded=Date.now();renderPanel();if(dialog.open)render();
  }
  function renderPanel() {
    $('leave-group').hidden=!state.session;
    $('leave-group').disabled=!canLeave || leaveBusy || state.loading;
    $('leave-group-hint').textContent=state.session ? leaveBlockedReason : '';
    $('leave-group-hint').hidden=!state.session || !leaveBlockedReason;
    const query=$('group-panel-search').value.trim().toLowerCase();
    const matching=panelMembers.filter(member=>`${member.displayName} ${member.username}`.toLowerCase().includes(query));
    const externalMatching=externalMembers.filter(member=>member.displayName.toLowerCase().includes(query));
    $('group-panel-count').textContent=String(panelMembers.length+externalMembers.length);
    $('group-panel-members').replaceChildren(...matching.map(member=>{
      const card=node('div','group-person');card.title=`${member.displayName} · ${member.username}${member.disabled ? ' · 已停用' : ''}`;
      const avatar=node('div',`group-person-avatar tone-${[...member.id].reduce((sum,c)=>sum+c.charCodeAt(0),0)%5}`,member.displayName.slice(-2));avatar.setAttribute('aria-hidden','true');
      card.append(avatar,node('span','group-person-name',member.displayName),node('small','group-person-role',member.disabled ? '已停用' : member.id===state.user?.id ? '我' : member.id===state.session?.ownerId ? '创建人' : '成员'));
      if(removable(member))card.append(removeButton(member));return card;
    }));
    for(const member of externalMatching){
      const source=externalSource(member);
      const card=node('div','group-person group-external-person');card.title=`${member.displayName} · ${source}参与人`;
      const avatar=node('div','group-person-avatar weixin-avatar',member.displayName.slice(-2));avatar.setAttribute('aria-hidden','true');
      card.append(avatar,node('span','group-person-name',member.displayName),node('small','group-person-role',`${source}${['paused','disabled'].includes(member.status) ? ' · 暂停' : ['expired','disconnected','error'].includes(member.status) ? ' · 未连接' : ''}`));
      $('group-panel-members').append(card);
    }
    if(!panelBusy) $('group-panel-status').textContent=!state.session ? '添加同事，开始一个群聊。' : query && !matching.length && !externalMatching.length ? '没有匹配成员，试试姓名或账号。' : !panelMembers.length && !externalMembers.length ? '暂无成员' : '';
  }
  function resetPanel() {
    leaveRequest++;leaveTarget=null;leaveBusy=false;canLeave=false;leaveBlockedReason='';if(leaveDialog.open)leaveDialog.close();
    $('leave-group').hidden=true;$('leave-group-hint').hidden=true;
    request++;people=[];members=[];externalMembers=[];selected.clear();saving=false;if(dialog.open)dialog.close();
    $('group-member-roster').replaceChildren();$('group-member-options').replaceChildren();$('group-members-summary').textContent='';
    removeRequest++;removeTarget=null;removeBusy=false;canRemoveMembers=false;groupOwnerId=null;if(removeDialog.open)removeDialog.close();
    panelRequest++;panelKey='';panelMembers=[];panelLoaded=0;panelBusy=false;panelRevision=undefined;
    $('group-panel-search').value='';$('group-panel-members').replaceChildren();$('group-panel-count').textContent='0';$('group-panel-status').textContent='';
  }
  async function syncPanel(force=false) {
    const owner=state.user?.id,epoch=state.identityEpoch,id=state.session?.id;
    $('group-panel-name').textContent=state.session?.title || '新建群聊';
    const key=`${epoch}:${owner}:${id||''}`;
    if(key!==panelKey){resetPanel();panelKey=key;renderPanel();}
    if(!owner || !id)return;
    if(panelBusy || (!force && panelRevision===state.session?.revision && Date.now()-panelLoaded<15000))return;
    const token=++panelRequest;panelBusy=true;$('group-panel-status').textContent='正在加载成员…';
    try {
      const result=await api(`/api/sessions/${encodeURIComponent(id)}/members`);
      if(token!==panelRequest || state.identityEpoch!==epoch || state.user?.id!==owner || state.session?.id!==id)return;
      panelRevision=state.session.revision;panelBusy=false;applyMembers(result);
    }catch(e){if(token===panelRequest){panelBusy=false;panelLoaded=Date.now();panelRevision=state.session?.revision;$('group-panel-status').textContent=`成员加载失败：${e.message}`;}}
  }
  const valid = (owner, epoch, id) => state.user?.id === owner && state.identityEpoch === epoch && state.session?.id === id && dialog.open;
  const error = text => { $('group-members-error').textContent = text; $('group-members-error').hidden = !text; };
  function render() {
    const ids = new Set(members.map(member => member.id));
    const query = $('group-member-search').value.trim().toLowerCase();
    $('group-members-summary').textContent = `${members.length+externalMembers.length} 位参与成员${externalMembers.length ? `（含 ${externalMembers.length} 位外部参与人）` : ''} · 仅群成员可见`;
    $('group-member-roster').replaceChildren(...members.map(member => {const chip=node('span', 'group-member-chip', `${member.displayName}${member.disabled ? '（已停用）' : ''}`);if(removable(member))chip.append(removeButton(member));return chip;}),...externalMembers.map(member=>node('span','group-member-chip weixin-member-chip',`${member.displayName} · ${externalSource(member)}`)));
    const matches = people.filter(person => `${person.displayName} ${person.username}`.toLowerCase().includes(query));
    const list = $('group-member-options'); list.replaceChildren();
    for (const person of matches) {
      const label = node('label','group-member-option');
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.value = person.id;
      checkbox.checked = ids.has(person.id) || selected.has(person.id); checkbox.disabled = saving || ids.has(person.id);
      const identity = node('span'); identity.append(node('strong','',person.displayName),node('small','',person.username));
      label.append(checkbox,identity,node('span','group-member-state',ids.has(person.id) ? '已加入' : ''));
      checkbox.addEventListener('change',()=>{checkbox.checked ? selected.add(person.id) : selected.delete(person.id); updateButton();}); list.append(label);
    }
    if (!matches.length) list.append(node('p','admin-empty','没有匹配的员工，试试姓名或账号。'));
    updateButton();
  }
  function updateButton() { $('add-group-members').disabled = saving || selected.size === 0; $('add-group-members').textContent = saving ? '正在添加…' : `添加成员${selected.size ? `（${selected.size}）` : ''}`; }
  async function open() {
    if(state.loading){toast('请等待当前操作完成。');return;}
    const owner = state.user?.id, epoch = state.identityEpoch, selection=state.historyRequest;
    let token,sessionId;
    try {
      const session = await ensureSession();
      if (!session || state.user?.id !== owner || state.identityEpoch !== epoch || state.historyRequest!==selection || state.session?.id!==session.id || dialog.open) return;
      token=++request;sessionId=session.id;
      dialog.dataset.sessionId = session.id; people=[];members=[];externalMembers=[];selected.clear();saving=false;
      $('group-member-search').value=''; error(''); render(); $('group-members-summary').textContent='正在加载成员…';
      dialog.showModal();
      const [directory, group] = await Promise.all([api('/api/directory'), api(`/api/sessions/${encodeURIComponent(session.id)}/members`)]);
      if (!valid(owner,epoch,session.id) || token !== request) return;
      people=directory.users;applyMembers(group);$('group-member-search').focus();
    } catch (e) { if (state.user?.id !== owner || state.identityEpoch !== epoch || (token!==undefined && (token!==request || state.session?.id!==sessionId))) return; dialog.open ? error(e.message) : toast(e.message); }
  }
  $('group-member-search').addEventListener('input',render);
  $('close-group-members').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{request++;selected.clear();people=[];members=[];});
  $('group-members-form').addEventListener('submit',async event=>{
    event.preventDefault();if(saving || !selected.size)return;
    const owner=state.user?.id,epoch=state.identityEpoch,id=dialog.dataset.sessionId;
    saving=true;error('');render();
    try {
      const result=await api(`/api/sessions/${encodeURIComponent(id)}/members`,{method:'POST',body:{userIds:[...selected]}});
      if(!valid(owner,epoch,id))return;
      selected.clear();applyMembers(result);syncPanel(true);toast(result.addedCount ? `已添加 ${result.addedCount} 位成员` : '所选员工已在群内');
    }catch(e){if(valid(owner,epoch,id))error(e.message);}
    finally{if(valid(owner,epoch,id)){saving=false;render();}}
  });
  $('open-group-members').addEventListener('click',open);
  $('group-panel-add').addEventListener('click',open);
  $('group-panel-search').addEventListener('input',renderPanel);
  $('refresh-group-panel').addEventListener('click',()=>syncPanel(true));
  $('close-group-panel').addEventListener('click',()=>{$('context-panel').classList.remove('open');$('toggle-context').setAttribute('aria-expanded','false');$('toggle-context').focus();});
  for(const id of ['cancel-remove-member','close-remove-member'])$(id).addEventListener('click',()=>{if(!removeBusy)removeDialog.close();});
  removeDialog.addEventListener('cancel',event=>{if(removeBusy)event.preventDefault();});
  removeDialog.addEventListener('close',()=>{removeRequest++;removeTarget=null;removeBusy=false;});
  $('remove-group-member-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!removeTarget || removeBusy)return;
    const target=removeTarget,token=++removeRequest;
    const validRemoval=()=>token===removeRequest && removeDialog.open && state.user?.id===target.userId && state.identityEpoch===target.epoch && state.session?.id===target.sessionId;
    removeBusy=true;$('confirm-remove-member').disabled=true;$('confirm-remove-member').textContent='正在移除…';$('remove-group-member-error').hidden=true;
    try {
      const result=await api(`/api/sessions/${encodeURIComponent(target.sessionId)}/members/${encodeURIComponent(target.id)}`,{method:'DELETE',body:{}});
      if(!validRemoval())return;
      applyMembers(result);removeDialog.close();toast(`已移除 ${target.displayName}`);syncPanel(true);
    }catch(e){if(validRemoval()){$('remove-group-member-error').textContent=e.message;$('remove-group-member-error').hidden=false;}}
    finally{if(validRemoval()){removeBusy=false;$('confirm-remove-member').disabled=false;$('confirm-remove-member').textContent='确认移除';}}
  });
  $('leave-group').addEventListener('click',()=>{
    if(!state.session || !canLeave || leaveBusy || state.loading)return;
    leaveTarget={id:state.session.id,userId:state.user.id,epoch:state.identityEpoch};leaveRequest++;
    $('leave-group-name').textContent=state.session.title;
    $('leave-group-error').hidden=true;$('confirm-leave-group').disabled=false;$('confirm-leave-group').textContent='确认退出';
    leaveDialog.showModal();$('cancel-leave-group').focus();
  });
  for(const id of ['cancel-leave-group','close-leave-group'])$(id).addEventListener('click',()=>{if(!leaveBusy)leaveDialog.close();});
  leaveDialog.addEventListener('cancel',event=>{if(leaveBusy)event.preventDefault();});
  leaveDialog.addEventListener('close',()=>{leaveRequest++;leaveTarget=null;leaveBusy=false;});
  $('leave-group-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!leaveTarget || leaveBusy)return;
    const target=leaveTarget,token=++leaveRequest;
    const validLeave=()=>token===leaveRequest && leaveDialog.open && state.user?.id===target.userId && state.identityEpoch===target.epoch && state.session?.id===target.id;
    leaveBusy=true;$('confirm-leave-group').disabled=true;$('confirm-leave-group').textContent='正在退出…';$('leave-group-error').hidden=true;
    try {
      await api(`/api/sessions/${encodeURIComponent(target.id)}/leave`,{method:'POST',body:{}});
      if(!validLeave())return;
      onLeft(target.id);
      if(leaveDialog.open)leaveDialog.close();
    }catch(e){if(validLeave()){$('leave-group-error').textContent=e.message;$('leave-group-error').hidden=false;}}
    finally{if(validLeave()){leaveBusy=false;$('confirm-leave-group').disabled=false;$('confirm-leave-group').textContent='确认退出';}}
  });
  return {syncPanel,resetPanel,isLeaving:id=>leaveBusy && leaveTarget?.id===id};
}
