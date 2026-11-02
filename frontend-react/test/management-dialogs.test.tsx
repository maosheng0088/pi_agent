// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsDialog from '../src/components/SettingsDialog';
import MembersDialog from '../src/components/MembersDialog';
import HistorySearch from '../src/components/HistorySearch';
import CreateAgentDialog from '../src/components/CreateAgentDialog';

// Keep Semi's event/controlled-value contracts while isolating dialog lifecycle
// and real API logic from animation, popover layout and portal timing.
vi.mock('@douyinfe/semi-ui', () => ({
  Button: ({ children, htmlType, loading, theme, type, block, ...props }: any) => <button {...props} type={htmlType || 'button'}>{children}</button>,
  Modal: ({ visible, title, children, footer, onCancel }: any) => visible ? <section role="dialog" aria-label={title}><h2>{title}</h2>{children}<footer>{footer}</footer><button aria-label="关闭弹窗" onClick={onCancel}>×</button></section> : null,
  Form: ({ onSubmit, children, ...props }: any) => <form {...props} onSubmit={event => { event.preventDefault(); onSubmit?.({}); }}>{children}</form>,
  Input: ({ onChange, showClear, ...props }: any) => <input {...props} onChange={event => onChange?.(event.target.value)} />,
  TextArea: ({ onChange, ...props }: any) => <textarea {...props} onChange={event => onChange?.(event.target.value)} />,
  Select: ({ onChange, optionList, ...props }: any) => <select {...props} onChange={event => onChange?.(event.target.value)}>{optionList?.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>,
  Checkbox: ({ children, onChange, ...props }: any) => <label><input {...props} type="checkbox" onChange={event => onChange?.(event)} />{children}</label>,
  Radio: ({ children, ...props }: any) => <label><input {...props} type="radio" />{children}</label>,
  RadioGroup: ({ children }: any) => <div>{children}</div>,
  Spin: () => <span>加载中</span>, Tag: ({ children }: any) => <span>{children}</span>,
  Toast: { success: vi.fn(), info: vi.fn() },
}));
vi.mock('../src/components/AvatarPicker', () => ({ default: ({ value, onChange, disabled, label }: any) => <label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="">自动推荐</option><option value="portrait-14">冰蓝</option></select></label> }));
vi.mock('../src/components/UserAvatar', () => ({ default: () => <span aria-hidden="true" /> }));
vi.mock('../src/components/AgentAvatar', () => ({ default: () => <span aria-hidden="true" /> }));
vi.mock('../src/components/ChannelMark', () => ({ default: () => <span aria-hidden="true" /> }));
vi.mock('../src/lib/artwork', () => ({ channelIdentity: () => ({ label: '个人微信' }) }));

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const admin = { id: 'admin', username: 'admin', displayName: '管理员', role: 'admin' };
const coworker = { id: 'coworker', username: '009001', displayName: '同事示例员工001', role: 'member' };
const group = { id: 'alpha', title: '报价助手', ownerId: admin.id };
const defaultConfig = { provider: 'custom', model: 'qa-model', baseUrl: 'https://api.example.com', cwd: 'D:/workspace', mode: 'workspace', systemPrompt: '业务要求', apiKeySet: true };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => { fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('React management dialog behavior', () => {
  it('keeps settings drafts during status refresh and omits an unchanged API key', async () => {
    const writes: any[] = [], onSaved = vi.fn(), onClose = vi.fn();
    fetcher.mockImplementation((path: string, init: RequestInit) => {
      if (path === '/api/config' && init.method === 'PUT') { writes.push(JSON.parse(String(init.body))); return Promise.resolve(json({ ok: true })); }
      if (path === '/api/config') return Promise.resolve(json(defaultConfig));
      if (path.startsWith('/api/models?')) return Promise.resolve(json({ models: [{ id: 'qa-model' }], providers: [] }));
      throw new Error(`Unexpected ${path}`);
    });
    const view = render(<SettingsDialog open status={{ configured: true }} onSaved={onSaved} onClose={onClose} />);
    await screen.findByDisplayValue('qa-model');
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'new-model' } });
    const loads = fetcher.mock.calls.length;
    view.rerender(<SettingsDialog open status={{ configured: true, running: 2 }} onSaved={onSaved} onClose={onClose} />);
    expect((screen.getByLabelText('模型 ID') as HTMLInputElement).value).toBe('new-model');
    expect(fetcher.mock.calls).toHaveLength(loads);
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ model: 'new-model', cwd: 'D:/workspace', mode: 'workspace' });
    expect(writes[0]).not.toHaveProperty('apiKey');
    expect(onSaved).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
  });

  it('clears a newly entered key immediately and does not save a cancelled settings draft', async () => {
    let release!: (response: Response) => void;
    fetcher.mockImplementation((path: string, init: RequestInit) => {
      if (path === '/api/config' && init.method === 'PUT') return new Promise<Response>(resolve => { release = resolve; });
      return Promise.resolve(json(path === '/api/config' ? defaultConfig : { models: [] }));
    });
    const onClose = vi.fn(), onSaved = vi.fn();
    const view = render(<SettingsDialog open status={{}} onClose={onClose} onSaved={onSaved} />);
    await screen.findByDisplayValue('qa-model');
    fireEvent.change(screen.getByLabelText(/API Key 已配置/), { target: { value: 'fake-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    expect((screen.getByLabelText(/API Key 已配置/) as HTMLInputElement).value).toBe('');
    await act(async () => release(json({ ok: true })));
    view.rerender(<SettingsDialog open={false} status={{}} onClose={onClose} onSaved={onSaved} />);
    view.rerender(<SettingsDialog open status={{}} onClose={onClose} onSaved={onSaved} />);
    await screen.findByDisplayValue('qa-model');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(fetcher.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(1);
  });

  it('preserves member selection on same-group updates and enforces removal boundaries', async () => {
    const writes: string[] = [];
    const roster = { members: [admin, coworker], externalMembers: [], ownerId: admin.id, canRemoveMembers: true, canLeave: false };
    fetcher.mockImplementation((path: string, init: RequestInit) => {
      if (init.method === 'DELETE') { writes.push(path); return Promise.resolve(json({ ...roster, members: [admin] })); }
      return Promise.resolve(json(path === '/api/directory' ? { users: [admin, coworker, { ...coworker, id: 'invite', displayName: '待邀请同事' }] } : roster));
    });
    const view = render(<MembersDialog open session={group} user={admin} onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: '移除成员 同事示例员工001' });
    expect(screen.queryByRole('button', { name: '移除成员 管理员' })).toBeNull();
    fireEvent.change(screen.getByLabelText('搜索同事姓名或账号'), { target: { value: '待邀请' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /待邀请同事/ }));
    const loads = fetcher.mock.calls.length;
    view.rerender(<MembersDialog open session={{ ...group, title: '后台更新群名', revision: 22 }} user={admin} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect((screen.getByLabelText('搜索同事姓名或账号') as HTMLInputElement).value).toBe('待邀请');
    expect((screen.getByRole('checkbox', { name: /待邀请同事/ }) as HTMLInputElement).checked).toBe(true);
    expect(fetcher.mock.calls).toHaveLength(loads);
    fireEvent.click(screen.getByRole('button', { name: '移除成员 同事示例员工001' }));
    fireEvent.click(screen.getByRole('button', { name: '确认移除' }));
    await waitFor(() => expect(writes).toEqual(['/api/sessions/alpha/members/coworker']));
  });

  it('invites the selected people only on submission and ordinary members cannot remove', async () => {
    const writes: any[] = [], onChanged = vi.fn();
    const roster = { members: [admin], externalMembers: [], ownerId: admin.id, canRemoveMembers: false, canLeave: true };
    fetcher.mockImplementation((path: string, init: RequestInit) => {
      if (init.method === 'POST') { writes.push(JSON.parse(String(init.body))); return Promise.resolve(json({ ...roster, members: [admin, coworker] })); }
      return Promise.resolve(json(path === '/api/directory' ? { users: [admin, coworker] } : roster));
    });
    render(<MembersDialog open session={group} user={coworker} onClose={vi.fn()} onChanged={onChanged} />);
    await screen.findByRole('checkbox', { name: /同事示例员工001/ });
    expect(screen.queryByRole('button', { name: /移除成员/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /同事示例员工001/ })); expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '添加成员（1）' }));
    await waitFor(() => expect(writes).toEqual([{ userIds: [coworker.id] }]));
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('uses real search pagination and safe highlighting, then locates the original message index', async () => {
    const onLocate = vi.fn(), onClose = vi.fn();
    fetcher.mockImplementation((path: string) => {
      const query = new URL(path, 'http://localhost').searchParams, offset = Number(query.get('offset'));
      return Promise.resolve(json({ results: Array.from({ length: offset ? 1 : 30 }, (_, index) => ({ role: 'user', content: '报价 <script>示例</script>', authorName: '同事', messageIndex: offset + index })), total: 31 }));
    });
    render(<HistorySearch open session={group} onLocate={onLocate} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('聊天记录关键词'), { target: { value: '报价' } });
    await waitFor(() => expect(screen.getAllByRole('button', { name: /定位到消息/ })).toHaveLength(30));
    expect(document.querySelector('script')).toBeNull(); expect(document.querySelectorAll('mark')).toHaveLength(30);
    fireEvent.click(screen.getByRole('button', { name: '加载更多 · 30 / 31' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /定位到消息/ })).toHaveLength(31));
    expect(fetcher.mock.calls.some(([path]) => path.includes('offset=30'))).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: /定位到消息/ })[30]!);
    expect(onLocate).toHaveBeenCalledWith(30); expect(onClose).toHaveBeenCalledOnce();
  });

  it('discards a late history response after switching groups', async () => {
    let release!: (response: Response) => void;
    fetcher.mockImplementation((path: string) => path.includes('/alpha/') ? new Promise<Response>(resolve => { release = resolve; }) : Promise.resolve(json({ results: [], total: 0 })));
    const view = render(<HistorySearch open session={group} onLocate={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('聊天记录关键词'), { target: { value: '报价' } });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    view.rerender(<HistorySearch open session={{ ...group, id: 'beta' }} onLocate={vi.fn()} onClose={vi.fn()} />);
    await act(async () => release(json({ results: [{ role: 'user', content: '旧群机密结果', messageIndex: 0 }], total: 1 })));
    expect(screen.queryByText('旧群机密结果')).toBeNull();
    expect((screen.getByLabelText('聊天记录关键词') as HTMLInputElement).value).toBe('');
  });

  it('retries partial agent configuration using the original created ID and preserves skill scope', async () => {
    const writes: Array<{ path: string; body: any }> = []; let memberAttempts = 0;
    fetcher.mockImplementation((path: string, init: RequestInit) => {
      if (init.method !== 'GET') {
        writes.push({ path, body: JSON.parse(String(init.body)) });
        if (path === '/api/sessions') return Promise.resolve(json({ session: { id: 'created-agent' } }));
        if (path.endsWith('/members') && memberAttempts++ === 0) return Promise.resolve(json({ error: '临时邀请失败' }, 503));
        return Promise.resolve(json({ ok: true }));
      }
      if (path === '/api/skills') return Promise.resolve(json({ skills: [{ id: 'skill', name: '报价技能', enabled: true, scope: 'groups', groupIds: ['alpha'], avatarId: 'portrait-03' }] }));
      if (path === '/api/directory') return Promise.resolve(json({ users: [admin, coworker] }));
      return Promise.resolve(json({ channels: [{ id: 'wechat', type: 'weixin', name: '业务微信' }, { id: 'bound', type: 'wecom', name: '已绑定企微', sessionId: 'other' }] }));
    });
    const onCreated = vi.fn();
    render(<CreateAgentDialog open user={admin} onClose={vi.fn()} onCreated={onCreated} />);
    await screen.findByRole('checkbox', { name: /报价技能/ });
    fireEvent.change(screen.getByLabelText('智能体名称'), { target: { value: '专业报价助手' } });
    fireEvent.change(screen.getByLabelText('智能体头像'), { target: { value: 'portrait-14' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /报价技能/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /同事示例员工001/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /业务微信/ }));
    expect((screen.getByRole('checkbox', { name: /已绑定企微/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '创建智能体' }));
    await screen.findByText(/智能体已创建，部分配置未完成/);
    expect((screen.getByLabelText('智能体名称') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '完成配置' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('created-agent'));
    expect(writes.filter(write => write.path === '/api/sessions')).toEqual([{ path: '/api/sessions', body: { title: '专业报价助手', avatarId: 'portrait-14', channelIds: ['wechat'] } }]);
    expect(writes.find(write => write.path === '/api/admin/skills/skill')?.body).toEqual({ scope: 'groups', groupIds: ['alpha', 'created-agent'] });
    expect(memberAttempts).toBe(2);
  });

  it('blocks creation data loading and writes for a non-admin', async () => {
    render(<CreateAgentDialog open user={coworker} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe('仅管理员可创建智能体。');
    expect(fetcher).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '创建智能体' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
