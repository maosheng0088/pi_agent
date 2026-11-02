import { useEffect, useId, useRef, useState } from 'react';
import { Button, Form, Input, Modal } from '@douyinfe/semi-ui';
import { api, errorMessage } from '../lib/api';
import type { Session } from '../lib/types';
import './management-dialogs.css';

interface Props { open: boolean; embedded?: boolean; session: Session; onClose(): void; onLocate(index: number): void }
interface SearchResult { role: string; content: string; snippet?: string; messageIndex: number; authorName?: string; timestamp?: string | number }
function clock(value?: string | number) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false }); }
function highlight(text: string, needle: string) {
  if (!needle) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = []; let start = 0, index = 0;
  while ((index = text.toLowerCase().indexOf(needle.toLowerCase(), start)) >= 0) {
    parts.push({ text: text.slice(start, index), hit: false }, { text: text.slice(index, index + needle.length), hit: true }); start = index + needle.length;
  }
  parts.push({ text: text.slice(start), hit: false }); return parts;
}

export default function HistorySearch({ open, embedded = false, session, onClose, onLocate }: Props) {
  const id = useId();
  const [query, setQuery] = useState(''), [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const version = useRef(0), timer = useRef<ReturnType<typeof setTimeout>>(), controller = useRef<AbortController>();

  useEffect(() => { setQuery(''); setResults([]); setTotal(0); setError(''); setBusy(false); }, [open, session.id]);
  useEffect(() => {
    version.current++; clearTimeout(timer.current); controller.current?.abort();
    setResults([]); setTotal(0); setError(''); setBusy(false);
    if (open && query.trim()) timer.current = setTimeout(() => void search(), 300);
    return () => { version.current++; clearTimeout(timer.current); controller.current?.abort(); };
  }, [query, open, session.id]);

  async function search(more = false) {
    clearTimeout(timer.current); controller.current?.abort();
    const text = query.trim(), token = ++version.current;
    if (!open || !text) { setResults([]); setTotal(0); setBusy(false); return; }
    if (text.length > 200) { setError('关键词不能超过 200 个字符。'); return; }
    const request = new AbortController(); controller.current = request;
    const offset = more ? results.length : 0;
    setBusy(true); setError(''); if (!more) setResults([]);
    try {
      const params = new URLSearchParams({ q: text, limit: '30', offset: String(offset) });
      const result = await api<{ results: SearchResult[]; total: number }>(`/api/sessions/${encodeURIComponent(session.id)}/search?${params}`, { signal: request.signal });
      if (token === version.current) { setResults(previous => more ? [...previous, ...result.results] : result.results); setTotal(result.total); }
    } catch (reason) { if (token === version.current && !request.signal.aborted) setError(errorMessage(reason)); }
    finally { if (token === version.current) setBusy(false); }
  }

  const content = <>
    <p className="pi-dialog-description">仅搜索「{session.title}」的协作记录。</p>
    <Form className="pi-history-search-bar" onSubmit={() => void search()}>
      <label className="pi-visually-hidden" htmlFor={`history-${id}`}>聊天记录关键词</label>
      <Input id={`history-${id}`} value={query} onChange={setQuery} type="search" placeholder="搜索消息或任务结果" maxLength={200} composition showClear autoFocus />
      <Button theme="solid" type="primary" htmlType="submit" loading={busy} disabled={!query.trim()}>查找</Button>
    </Form>
    {error && <div className="pi-dialog-error" role="alert">{error}</div>}
    {!query.trim() ? <div className="pi-dialog-empty">输入关键词，找到之前的消息与结果。</div> : <>
      <div className="pi-history-summary" role="status">{busy ? '正在查找…' : `找到 ${total} 条相关消息`}</div>
      <div className="pi-history-results">{results.map(item => <button className="pi-history-result" key={item.messageIndex} type="button" disabled={!Number.isInteger(item.messageIndex) || item.messageIndex < 0} onClick={() => { onLocate(item.messageIndex); onClose(); }}>
        <span className="pi-history-result-meta"><strong>{item.role === 'assistant' ? session.title : item.authorName || '历史成员'}</strong><time>{clock(item.timestamp)}</time></span>
        <span className="pi-history-result-text">{highlight(item.snippet || item.content || '', query.trim()).map((part, index) => part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</span>
        <span className="pi-history-result-link">定位到消息 →</span>
      </button>)}{!busy && !results.length && <div className="pi-dialog-empty">没有找到匹配记录，试试其他关键词。</div>}</div>
      {results.length < total && <Button block theme="light" className="pi-history-more" disabled={busy} onClick={() => void search(true)}>加载更多 · {results.length} / {total}</Button>}
    </>}
  </>;
  return embedded ? <div className="conversation-history-search">{content}</div> : <Modal visible={open} title="查找聊天记录" className="pi-management-modal" width={760} onCancel={onClose} footer={<Button type="tertiary" theme="light" onClick={onClose}>关闭</Button>}>{content}</Modal>;
}
