import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Form, Input, Modal, Radio, RadioGroup, Select, Spin, TextArea, Toast } from '@douyinfe/semi-ui';
import { api, errorMessage } from '../lib/api';
import './management-dialogs.css';

interface Props { open: boolean; status: any; onClose(): void; onSaved(): void }
interface Config { provider: string; model: string; baseUrl: string; cwd: string; mode: string; systemPrompt: string; apiKeySet: boolean }
type Model = { id: string; name?: string };
const emptyConfig = (): Config => ({ provider: 'custom', model: '', baseUrl: '', cwd: '', mode: 'read-only', systemPrompt: '', apiKeySet: false });
const providerNames: Record<string, string> = { custom: 'OpenAI 兼容接口', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', deepseek: 'DeepSeek', openrouter: 'OpenRouter', 'minimax-cn': 'MiniMax 中国' };

export default function SettingsDialog({ open, onClose, onSaved }: Props) {
  const id = useId(), formId = `settings-form-${id}`;
  const [config, setConfig] = useState<Config>(emptyConfig);
  const [apiKey, setApiKey] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [remoteProviders, setRemoteProviders] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false), [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const version = useRef(0), savingRef = useRef(false), controller = useRef<AbortController>();

  useEffect(() => {
    const token = ++version.current;
    const request = new AbortController(); controller.current = request;
    savingRef.current = false; setSaving(false); setApiKey(''); setKeyVisible(false);
    setError(''); setReady(false); setModels([]); setRemoteProviders([]);
    if (!open) return () => { version.current++; request.abort(); };
    setLoading(true);
    void api<Partial<Config>>('/api/config', { signal: request.signal }).then(result => {
      if (version.current !== token) return;
      setConfig({ provider: result.provider || 'custom', model: result.model || '', baseUrl: result.baseUrl || '', cwd: result.cwd || '', mode: result.mode || 'read-only', systemPrompt: result.systemPrompt || '', apiKeySet: !!result.apiKeySet });
      setReady(true);
    }).catch(reason => { if (version.current === token && !request.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (version.current === token) setLoading(false); });
    return () => { version.current++; request.abort(); };
  }, [open]);

  useEffect(() => {
    if (!open || !ready) return;
    const request = new AbortController(); let current = true;
    void api<{ models?: Model[]; providers?: Model[] }>(`/api/models?provider=${encodeURIComponent(config.provider)}`, { signal: request.signal }).then(result => {
      if (current) { setModels(result.models || []); setRemoteProviders(result.providers || []); }
    }).catch(() => { if (current) setModels([]); });
    return () => { current = false; request.abort(); };
  }, [open, ready, config.provider]);

  const providers = useMemo(() => [...new Set([...Object.keys(providerNames), config.provider, ...remoteProviders.map(provider => provider.id)])].filter(Boolean)
    .map(value => ({ value, label: remoteProviders.find(provider => provider.id === value)?.name || providerNames[value] || value })), [config.provider, remoteProviders]);
  const update = <K extends keyof Config>(key: K, value: Config[K]) => setConfig(previous => ({ ...previous, [key]: value }));
  function close() { if (!savingRef.current) { setApiKey(''); setKeyVisible(false); onClose(); } }
  async function save() {
    if (savingRef.current || loading || !ready) return;
    if (!config.model.trim()) { setError('请填写模型 ID。'); return; }
    if (!config.cwd.trim()) { setError('请填写工作目录。'); return; }
    if (!config.apiKeySet && !apiKey.trim()) { setError('请输入模型服务的 API Key。'); return; }
    if (config.baseUrl.trim()) {
      try { if (!['http:', 'https:'].includes(new URL(config.baseUrl.trim()).protocol)) throw new Error(); }
      catch { setError('请输入有效的 HTTP 或 HTTPS API 地址。'); return; }
    }
    const token = version.current;
    const body = { provider: config.provider, model: config.model.trim(), baseUrl: config.baseUrl.trim(), cwd: config.cwd.trim(), mode: config.mode, systemPrompt: config.systemPrompt, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
    // The key is intentionally never logged or returned in a notification.
    setApiKey(''); setKeyVisible(false); savingRef.current = true; setSaving(true); setError('');
    try {
      await api('/api/config', { method: 'PUT', body, signal: controller.current?.signal });
      if (token !== version.current) return;
      onSaved(); Toast.success('业务空间配置已保存。'); onClose();
    } catch (reason) { if (token === version.current && !controller.current?.signal.aborted) setError(errorMessage(reason)); }
    finally { if (token === version.current) { savingRef.current = false; setSaving(false); } }
  }

  return <Modal visible={open} title="业务空间设置" className="pi-management-modal" width={700} onCancel={close} maskClosable={!saving} closeOnEsc={!saving} closable={!saving}
    footer={<><Button theme="light" type="tertiary" disabled={saving} onClick={close}>取消</Button><Button theme="solid" type="primary" htmlType="submit" form={formId} loading={saving} disabled={loading || !ready}>保存配置</Button></>}>
    <p className="pi-dialog-description">统一配置模型连接、工作目录与默认执行能力。</p>
    {error && <div className="pi-dialog-error" role="alert">{error}</div>}
    {loading ? <div className="pi-dialog-empty" role="status"><Spin />正在读取最新配置…</div> : <Form id={formId} className="pi-dialog-form" onSubmit={() => void save()}>
      <fieldset disabled={saving || !ready} className="pi-dialog-fieldset">
        <h3 className="pi-dialog-section-title">模型连接</h3>
        <div className="pi-dialog-grid">
          <div className="pi-dialog-field"><label htmlFor={`provider-${id}`}>模型提供商</label><Select id={`provider-${id}`} aria-label="模型提供商" value={config.provider} optionList={providers} disabled={saving || !ready} onChange={value => update('provider', String(value))} style={{ width: '100%' }} /></div>
          <div className="pi-dialog-field"><label htmlFor={`model-${id}`}>模型 ID</label><Input id={`model-${id}`} value={config.model} onChange={value => update('model', value)} list={`model-list-${id}`} placeholder="例如 MiniMax-M3" autoComplete="off" /><datalist id={`model-list-${id}`}>{models.slice(0, 600).map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</datalist></div>
        </div>
        <div className="pi-dialog-field"><label htmlFor={`base-url-${id}`}>API 地址 <small>可选</small></label><Input id={`base-url-${id}`} value={config.baseUrl} onChange={value => update('baseUrl', value)} placeholder="使用提供商默认地址，或填写兼容接口地址" autoComplete="off" spellCheck={false} /></div>
        <div className="pi-dialog-field"><label htmlFor={`key-${id}`}>API Key <small>{config.apiKeySet ? '已配置' : '尚未配置'}</small></label><div className="pi-key-field"><Input id={`key-${id}`} value={apiKey} onChange={setApiKey} type={keyVisible ? 'text' : 'password'} placeholder={config.apiKeySet ? '留空保留现有密钥' : '输入模型服务的 API Key'} autoComplete="new-password" spellCheck={false} maxLength={4096} /><Button type="tertiary" theme="borderless" aria-label={keyVisible ? '隐藏 API Key' : '显示 API Key'} aria-pressed={keyVisible} onClick={() => setKeyVisible(value => !value)}>{keyVisible ? '隐藏' : '显示'}</Button></div><small>密钥保存在服务端，不会回传至浏览器；输入新密钥可替换。</small></div>
        <h3 className="pi-dialog-section-title">工作空间</h3>
        <div className="pi-dialog-field"><label htmlFor={`cwd-${id}`}>智能体工作区根目录</label><Input id={`cwd-${id}`} value={config.cwd} onChange={value => update('cwd', value)} placeholder="D:\code\pi-web\workspaces" autoComplete="off" spellCheck={false} /><small>新建智能体会按编号建立专属目录；已有智能体的目录保持不变。</small></div>
        <div className="pi-dialog-field"><label htmlFor={`prompt-${id}`}>系统提示词 <small>可选</small></label><TextArea id={`prompt-${id}`} value={config.systemPrompt} onChange={value => update('systemPrompt', value)} rows={4} placeholder="补充业务背景、回答要求与执行规范" /></div>
        <h3 className="pi-dialog-section-title">默认执行能力</h3>
        <RadioGroup direction="vertical" value={config.mode} onChange={event => update('mode', String(event.target.value))} aria-label="默认执行能力" disabled={saving || !ready}>
          <Radio value="read-only"><span className="pi-radio-copy"><strong>只读分析</strong><small>读取文件、检索与分析，不执行脚本。</small></span></Radio>
          <Radio value="workspace"><span className="pi-radio-copy"><strong>工作区执行</strong><small>允许写入文件、执行技能与系统命令。</small></span></Radio>
        </RadioGroup>
        <p className="pi-dialog-help">工具在本机执行；此设置控制可用能力，不提供系统级隔离。已有智能体可单独设置执行模式。</p>
      </fieldset>
    </Form>}
  </Modal>;
}
