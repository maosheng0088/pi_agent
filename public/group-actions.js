export function createGroupActions({ $, api, state, node, toast, ensureSession, applySession, locateMessage }) {
  const renameDialog = $('rename-group-dialog'), searchDialog = $('chat-search-dialog');
  let key = '', renameBusy = false, renameRequest = 0, searchRequest = 0, searchController, searchTimer;
  let results = [], total = 0, activeQuery = '', searchBusy = false;
  const identity = () => ({ user: state.user?.id, epoch: state.identityEpoch, group: state.session?.id });
  const same = snapshot => snapshot.user === state.user?.id && snapshot.epoch === state.identityEpoch && snapshot.group === state.session?.id;
  function setError(id, text = '') { $(id).textContent = text; $(id).hidden = !text; }
  function reset() {
    renameRequest++; searchRequest++; clearTimeout(searchTimer); searchController?.abort();
    if (renameDialog.open) renameDialog.close();
    if (searchDialog.open) searchDialog.close();
    renameBusy = false; searchBusy = false; results = []; total = 0; activeQuery = ''; key = '';
    $('chat-search-results').replaceChildren(); $('chat-search-query').value = ''; $('rename-group-name').value = '';
  }
  function sync() {
    const current = `${state.identityEpoch}:${state.user?.id}:${state.session?.id || ''}`;
    if (key !== current) { reset(); key = current; }
    $('open-chat-search').disabled = !state.session || state.loading;
    $('rename-group').disabled = state.loading;
    if (searchDialog.open) $('chat-search-scope').textContent = `仅搜索「${state.session?.title || '当前群聊'}」的消息`;
  }
  $('rename-group').addEventListener('click', async () => {
    const before = identity();
    try {
      const session = await ensureSession();
      if (!session || before.user !== state.user?.id || before.epoch !== state.identityEpoch || state.session?.id !== session.id || renameDialog.open) return;
      $('rename-group-name').value = session.title || '';
      renameBusy = false; renameRequest++;
      $('rename-group-save').disabled = false; $('rename-group-save').textContent = '保存群名';
      setError('rename-group-error'); renameDialog.showModal(); $('rename-group-name').focus(); $('rename-group-name').select();
    } catch (error) { if (before.user === state.user?.id && before.epoch === state.identityEpoch) toast(error.message); }
  });
  for (const id of ['rename-group-close', 'rename-group-cancel']) $(id).addEventListener('click', () => renameDialog.close());
  renameDialog.addEventListener('close', () => { renameRequest++; renameBusy = false; });
  $('rename-group-form').addEventListener('submit', async event => {
    event.preventDefault(); if (renameBusy || !state.session) return;
    const title = $('rename-group-name').value.trim();
    if (!title || title.length > 120) { setError('rename-group-error', '请输入 1–120 个字符的群名。'); $('rename-group-name').focus(); return; }
    renameBusy = true; const token = ++renameRequest; const before = identity();
    $('rename-group-save').disabled = true; $('rename-group-save').textContent = '正在保存…'; setError('rename-group-error');
    try {
      const response = await api(`/api/sessions/${encodeURIComponent(before.group)}`, { method: 'PATCH', body: { title } });
      if (!same(before)) return;
      applySession(response.session);
      if (token !== renameRequest || !renameDialog.open) return;
      renameDialog.close(); toast('群名已修改');
    } catch (error) {
      if (same(before) && token === renameRequest && renameDialog.open) setError('rename-group-error', error.message);
    } finally {
      if (token === renameRequest) { renameBusy = false; $('rename-group-save').disabled = false; $('rename-group-save').textContent = '保存群名'; }
    }
  });
  function highlighted(text, query) {
    const fragment = document.createDocumentFragment(); let position = 0;
    const haystack = text.toLowerCase(), needle = query.toLowerCase();
    for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, position)) {
      fragment.append(document.createTextNode(text.slice(position, index)), node('mark', '', text.slice(index, index + query.length)));
      position = index + query.length;
    }
    fragment.append(document.createTextNode(text.slice(position))); return fragment;
  }
  function renderResults() {
    $('chat-search-results').replaceChildren(...results.map(result => {
      const button = node('button', 'chat-search-result'); button.type = 'button';
      const metadata = node('span', 'chat-search-result-meta');
      const time = result.timestamp ? new Date(result.timestamp) : null;
      metadata.append(node('strong', '', result.role === 'assistant' ? 'Pi' : result.authorName || '历史发言人未记录'), node('time', '', time && !Number.isNaN(time.getTime()) ? time.toLocaleString('zh-CN', { hour12: false }) : '时间未记录'));
      const snippet = node('span', 'chat-search-result-text'); snippet.append(highlighted(result.snippet || result.content || '', activeQuery));
      button.append(metadata, snippet, node('span', 'chat-search-result-link', '定位到消息'));
      button.addEventListener('click', () => { const snapshot = identity(); searchDialog.close(); locateMessage(result.messageIndex, snapshot.group); });
      return button;
    }));
    $('chat-search-more').hidden = results.length >= total;
    $('chat-search-more').disabled = searchBusy;
  }
  async function search(more = false) {
    clearTimeout(searchTimer); const query = $('chat-search-query').value.trim();
    searchController?.abort(); const token = ++searchRequest; const snapshot = identity();
    if (!searchDialog.open || !snapshot.group) return;
    setError('chat-search-error');
    if (!query) { results = []; total = 0; activeQuery = ''; searchBusy = false; renderResults(); $('chat-search-status').textContent = '输入关键词，查找本群的历史消息。'; return; }
    if (query.length > 200) { setError('chat-search-error', '搜索关键词不能超过 200 个字符。'); return; }
    if (!more || query !== activeQuery) { results = []; total = 0; activeQuery = query; }
    searchBusy = true; renderResults(); $('chat-search-status').textContent = '正在查找…';
    searchController = new AbortController();
    try {
      const params = new URLSearchParams({ q: query, limit: '30', offset: String(results.length) });
      const response = await api(`/api/sessions/${encodeURIComponent(snapshot.group)}/search?${params}`, { signal: searchController.signal });
      if (!same(snapshot) || token !== searchRequest || !searchDialog.open) return;
      results.push(...response.results); total = response.total; searchBusy = false; renderResults();
      $('chat-search-status').textContent = total ? `找到 ${total} 条消息${results.length < total ? `，已显示 ${results.length} 条` : ''}` : '没有匹配的消息，试试其他关键词。';
    } catch (error) {
      if (!same(snapshot) || token !== searchRequest || !searchDialog.open || error.name === 'AbortError') return;
      searchBusy = false; $('chat-search-status').textContent = ''; setError('chat-search-error', error.message); renderResults();
    }
  }
  $('open-chat-search').addEventListener('click', () => {
    if (!state.session) return;
    $('chat-search-scope').textContent = `仅搜索「${state.session.title}」的消息`;
    searchDialog.showModal(); search(); $('chat-search-query').focus();
  });
  $('chat-search-close').addEventListener('click', () => searchDialog.close());
  searchDialog.addEventListener('close', () => { searchRequest++; searchController?.abort(); clearTimeout(searchTimer); searchBusy = false; });
  $('chat-search-form').addEventListener('submit', event => { event.preventDefault(); search(); });
  $('chat-search-query').addEventListener('input', () => { searchRequest++; searchController?.abort(); clearTimeout(searchTimer); searchTimer = setTimeout(() => search(), 300); });
  $('chat-search-more').addEventListener('click', () => search(true));
  return { sync, reset };
}
