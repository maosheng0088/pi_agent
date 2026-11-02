// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MessageContent from '../src/components/MessageContent';
import ChatView from '../src/ChatView';
import { workspace } from '../src/lib/workspace';

vi.hoisted(() => {
  // Semi's optional Lottie capability probes canvas during module import.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({ fillStyle: '', fillRect() {}, measureText: () => ({ width: 0 }), getImageData: () => ({ data: new Uint8ClampedArray(4) }) }) });
});

const { state, apiMock, sendMock, listeners } = vi.hoisted(() => ({ state: { value: {} as any }, apiMock: vi.fn(), sendMock: vi.fn(), listeners: new Set<() => void>() }));
vi.mock('../src/lib/api', async importOriginal => ({ ...await importOriginal<any>(), api: apiMock }));
vi.mock('../src/lib/workspace', async () => {
  const { useSyncExternalStore } = await import('react');
  const patch = (value: any) => { state.value = { ...state.value, ...value }; listeners.forEach(listener => listener()); };
  const store = {
    get state() { return state.value; }, get isAdmin() { return state.value.user?.role === 'admin'; },
    get active() { return !!state.value.running || !!state.value.current?.running; }, get canStop() { return false; },
    send: sendMock, patch,
    setDraft: (id: string, value: string) => patch({ drafts: { ...state.value.drafts, [id]: value } }),
    setSkill: (value: string) => patch({ selectedSkill: value }),
    toast: vi.fn(), refreshSessions: vi.fn(async () => {}), applySession: (current: any) => patch({ current }),
    navigate: vi.fn(), synchronize: vi.fn(), stop: vi.fn(), forget: vi.fn(),
  };
  return { workspace: store, useWorkspace: () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state.value) };
});

const route = '/api/sessions/alpha/attachments/b54981a6-963c-4c38-92e2-01da3b4af4e4';
const attachment = (name: string) => `${route}?name=${encodeURIComponent(name)}`;
const employee = { id: 'employee', displayName: '业务同事', username: '009001', role: 'member' };
const admin = { id: 'admin', displayName: '管理员', username: 'admin', role: 'admin' };
const group = { id: 'alpha', title: '报价助手', ownerId: admin.id, revision: 1, running: false, mode: 'workspace' };
function replace(value: any) { workspace.patch(value); }
const chatProps = () => ({ detailsOpen: true, onToggleDetails: vi.fn(), onOpenAgents: vi.fn(), onSettings: vi.fn() });
function finishModalAnimation() {
  // jsdom does not run CSS animations. Dispatch the same completion event Semi
  // receives in the browser, without replacing its Modal implementation.
  document.querySelectorAll('.semi-modal-content-animate-hide,.semi-modal-mask-animate-hide').forEach(element => {
    fireEvent.animationEnd(element);
    // React selects the prefixed event when jsdom lacks AnimationEvent.
    fireEvent(element, new Event('webkitAnimationEnd', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  state.value = { user: employee, current: group, sessions: [group], messages: [], skills: [], selectedSkill: '', view: 'chat', status: { configured: true }, online: true, loading: false, running: false, stopping: false, chatError: '', drafts: { alpha: '' } };
  apiMock.mockReset(); sendMock.mockReset().mockResolvedValue(true);
  apiMock.mockImplementation((path: string) => Promise.resolve(path.endsWith('/members')
    ? { members: [admin, employee], externalMembers: [], ownerId: admin.id, canRemoveMembers: state.value.user.role === 'admin', canLeave: true }
    : path.endsWith('/channels') ? { channels: [] } : path.includes('/search?') ? { results: [], total: 0 } : {}));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('Real Semi message rendering', () => {
  it('renders ordinary text safely', () => {
    render(<MessageContent content="普通回复 <script>不可执行</script>" />);
    expect(screen.getByText('普通回复 <script>不可执行</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
  });

  it('preserves user text and complete multiline fenced examples without clickable attachments', () => {
    const image = `![图](${attachment('chart.png')})`;
    const plain = render(<MessageContent plain content={image} />);
    expect(screen.queryByRole('img')).toBeNull(); expect(screen.queryByRole('link')).toBeNull(); plain.unmount();
    const code = `\`\`\`markdown\n第一行\n${image}\n[示例](https://files.example.com/report.pdf)\n\`\`\``;
    render(<MessageContent content={code} />);
    expect(document.querySelector('pre')?.textContent).toContain(image);
    expect(document.querySelector('pre')?.textContent).toContain('[示例](https://files.example.com/report.pdf)');
    expect(screen.queryByRole('img')).toBeNull(); expect(screen.queryByRole('link')).toBeNull();
  });

  it('keeps unsafe URLs and raw HTML inert, and never embeds remote Markdown images', () => {
    render(<MessageContent content={'[脚本](javascript:alert(1)) [本地](file:///D:/private.pdf) <img src=x onerror=alert(1)>\n![远程图片](https://files.example.com/chart.png) [帮助](https://example.com/help)'} />);
    expect(document.querySelector('[onerror]')).toBeNull(); expect(document.querySelector('script')).toBeNull();
    const links = screen.getAllByRole('link'); expect(links).toHaveLength(2);
    for (const link of links) { expect(link.getAttribute('target')).toBe('_blank'); expect(link.getAttribute('rel')).toContain('noopener'); expect(link.getAttribute('rel')).toContain('noreferrer'); }
    expect(document.querySelector('img[src="https://files.example.com/chart.png"]')).toBeNull();
    expect(screen.getByText('[脚本](javascript:alert(1)) [本地](file:///D:/private.pdf) <img src=x onerror=alert(1)>')).toBeTruthy();
  });

  it('renders only registered internal file routes with separate open and download actions', () => {
    render(<MessageContent content={`[业务表格](${attachment('report.xlsx')})`} />);
    const open = screen.getByRole('link', { name: '打开文件：report.xlsx' });
    expect(open.getAttribute('href')).toContain(route); expect(open.getAttribute('target')).toBe('_blank');
    const download = screen.getByRole('link', { name: '下载文件：report.xlsx' });
    expect(download.getAttribute('download')).toBe('report.xlsx'); expect(download.getAttribute('href')).toContain('download=1');
    expect(screen.queryByText(/KB|MB|已下载/)).toBeNull();
  });

  it('opens a genuine Semi image dialog and closes it with Escape', async () => {
    render(<MessageContent content={`![港口图](${attachment('port.png')})`} />);
    const preview = screen.getByRole('button', { name: '放大图片：港口图' });
    expect(preview.getAttribute('aria-haspopup')).toBe('dialog'); preview.focus(); fireEvent.click(preview);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: '港口图' }).getAttribute('src')).toContain(route);
    fireEvent.keyDown(document, { key: 'Escape', keyCode: 27 });
    finishModalAnimation();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(preview.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(preview);
  });

  it('falls back to a real downloadable card when an image cannot load', () => {
    render(<MessageContent content={`![业务图](${attachment('chart.png')})`} />);
    fireEvent.error(screen.getByRole('img', { name: '业务图' }));
    expect(screen.queryByRole('button', { name: '放大图片：业务图' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('预览不可用');
    expect(screen.getByRole('link', { name: '下载文件：chart.png' }).getAttribute('href')).toContain('download=1');
  });

  it('keeps preview errors recoverable and escapes image labels as attributes', async () => {
    render(<MessageContent content={`![<img src=x onerror=alert(1)>](${attachment('chart[final](1).png')})`} />);
    expect(document.querySelector('[onerror]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '放大图片：<img src=x onerror=alert(1)>' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.error(within(dialog).getByRole('img', { name: '<img src=x onerror=alert(1)>' }));
    expect(within(dialog).getByRole('status').textContent).toContain('图片暂时无法打开');
    expect(within(dialog).getByRole('button', { name: /下载图片/ })).toBeTruthy();
    expect(document.querySelector('[onerror]')).toBeNull();
  });
});

describe('Real Semi chat controls', () => {
  it('hides tool/intermediate output and admin configuration from employees', async () => {
    state.value.messages = [
      { role: 'user', authorId: employee.id, authorName: employee.displayName, content: '员工问题' },
      { role: 'assistant', content: '工具计划不可见', tools: [{ name: 'powershell' }] },
      { role: 'toolResult', content: '工具输出不可见' },
      { role: 'assistant', content: '最终真实结果' },
    ];
    render(<ChatView {...chatProps()} />);
    await screen.findByText('最终真实结果');
    expect(screen.queryByText('工具计划不可见')).toBeNull(); expect(screen.queryByText('工具输出不可见')).toBeNull();
    expect(screen.queryByText('更改模型')).toBeNull(); expect(screen.queryByText('可用工具')).toBeNull();
    expect(screen.queryByRole('button', { name: /^配置/ })).toBeNull();
    expect(screen.getByText('员工问题')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更多智能体操作' }));
    await screen.findByText('修改名称');
    expect(screen.queryByText('执行权限')).toBeNull();
    expect(screen.queryByText('修改名称与头像')).toBeNull();
  });

  it('sends with Enter while preserving Shift+Enter and native/composition/229 IME input', async () => {
    state.value.drafts.alpha = '查询报价';
    render(<ChatView {...chatProps()} />);
    const input = screen.getByRole('textbox', { name: '发送给报价助手的任务' });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(sendMock).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(sendMock).toHaveBeenCalledExactlyOnceWith('查询报价'));
  });

  it('does not send on Enter while disconnected or another task is running', async () => {
    state.value.drafts.alpha = '等待恢复后发送'; state.value.online = false;
    render(<ChatView {...chatProps()} />);
    const input = screen.getByRole('textbox', { name: '发送给报价助手的任务' });
    fireEvent.keyDown(input, { key: 'Enter' }); expect(sendMock).not.toHaveBeenCalled();
    act(() => replace({ online: true, current: { ...group, running: true } }));
    fireEvent.keyDown(input, { key: 'Enter' }); expect(sendMock).not.toHaveBeenCalled();
  });

  it('gives the real Semi skill combobox a stable accessible name and selects the requested skill', async () => {
    state.value.skills = [{ id: 'pickup', name: '提柜技能', enabled: true }];
    render(<ChatView {...chatProps()} />);
    const select = screen.getByRole('combobox', { name: '本次调用技能' });
    fireEvent.click(select);
    await waitFor(() => expect(select.getAttribute('aria-expanded')).toBe('true'));
    fireEvent.click(await screen.findByRole('option', { name: /提柜技能/ }));
    expect(state.value.selectedSkill).toBe('pickup');
    expect(screen.getByRole('combobox', { name: '本次调用技能' })).toBeTruthy();
  });

  it('closes group dialogs on group switch and does not leak an old search', async () => {
    render(<ChatView {...chatProps()} />);
    fireEvent.click(screen.getByRole('button', { name: '查找聊天记录' }));
    const dialog = await screen.findByRole('dialog', { name: '查找聊天记录' });
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: '旧群关键词' } });
    act(() => replace({ current: { ...group, id: 'beta', title: '提柜助手' }, messages: [] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByDisplayValue('旧群关键词')).toBeNull();
    expect(screen.getByRole('textbox', { name: '发送给提柜助手的任务' })).toBeTruthy();
  });

  it('searches the authorized group and locates the original message with real result interaction', async () => {
    state.value.messages = [{ role: 'assistant', content: '报价单 QA-001 已生成', timestamp: 100 }];
    apiMock.mockImplementation((path: string) => Promise.resolve(path.includes('/search?')
      ? { results: [{ role: 'assistant', content: '报价单 QA-001 已生成', messageIndex: 0 }], total: 1 }
      : path.endsWith('/members') ? { members: [employee], canRemoveMembers: false, canLeave: true } : { channels: [] }));
    render(<ChatView {...chatProps()} />);
    fireEvent.click(screen.getByRole('button', { name: '查找聊天记录' }));
    const dialog = await screen.findByRole('dialog', { name: '查找聊天记录' });
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'QA-001' } });
    const result = await within(dialog).findByRole('button', { name: /定位到消息/ }); fireEvent.click(result);
    finishModalAnimation();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.querySelector('[data-message-index="0"]')?.className).toContain('highlighted');
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(apiMock.mock.calls.some(([path]) => path.startsWith('/api/sessions/alpha/search?'))).toBe(true);
  });

  it('unmounts an open attachment preview when the user switches to another group', async () => {
    state.value.messages = [{ role: 'assistant', content: `![仅本群图片](${attachment('only-alpha.png')})` }];
    render(<ChatView {...chatProps()} />);
    fireEvent.click(screen.getByRole('button', { name: '放大图片：仅本群图片' }));
    await screen.findByRole('dialog');
    act(() => replace({ current: { ...group, id: 'beta', title: '提柜助手' }, messages: [] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.querySelector(`img[src*="only-alpha"]`)).toBeNull();
  });
});
