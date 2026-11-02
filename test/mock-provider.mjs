import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** Local test fixture speaking the same streaming protocol as OpenAI chat completions. */
export async function startMockProvider({ port = 0, readPath = 'fixture.txt', delayMs = 40 } = {}) {
  const requests = [];
  const activeResponses = new Set();
  let closedStreams = 0;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, fixture: true }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model', object: 'model', owned_by: 'local-test' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end('Mock endpoint not found');
      return;
    }

    let body;
    try {
      let input = '';
      for await (const chunk of req) input += chunk;
      body = JSON.parse(input);
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }
    requests.push(body);
    const messages = body.messages ?? [];
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const text = messageText(lastUser?.content);
    if (text.includes('[provider-error]')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Local fixture provider failure.', type: 'fixture_error' } }));
      return;
    }
    activeResponses.add(res);
    res.on('close', () => {
      activeResponses.delete(res);
      closedStreams += 1;
    });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const id = `chatcmpl-local-${requests.length}`;
    const send = (delta, finish_reason = null, usage) => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
      })}\n\n`);
    };
    const finish = (reason = 'stop') => {
      send({}, reason, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
      if (!res.destroyed && !res.writableEnded) res.end('data: [DONE]\n\n');
    };
    send({ role: 'assistant', content: '' });

    const last = messages.at(-1);

    // Dedicated email SDK integration marker. Other fixture branches are unchanged.
    if (text.includes('[email-read]') && last?.role !== 'tool'
      && body.tools?.some(tool => tool.function?.name === 'email_workspace')) {
      const accountId = /\[email-account:([a-f0-9-]+)\]/i.exec(text)?.[1];
      send({ tool_calls: [{ index: 0, id: 'call_email_read', type: 'function', function: {
        name: 'email_workspace', arguments: JSON.stringify({ action: 'search', accountId, params: { folder: 'INBOX', query: { subject: 'fixture' }, limit: 10 } }),
      } }] });
      finish('tool_calls'); return;
    }

    // Dedicated cloud SDK integration marker. Other fixture branches are unchanged.
    if (text.includes('[cloud-documents-read]') && last?.role !== 'tool'
      && body.tools?.some(tool => tool.function?.name === 'cloud_documents')) {
      send({ tool_calls: [{ index: 0, id: 'call_cloud_documents_read', type: 'function', function: {
        name: 'cloud_documents', arguments: JSON.stringify({ provider: 'tencent', action: 'call', params: { tool: 'general.read', arguments: { id: 'fixture-doc' } } }),
      } }] });
      finish('tool_calls'); return;
    }

    const documentMatch = [...text.matchAll(/\[read-document:([a-f0-9-]+)\]/ig)].at(-1);
    const documentId = documentMatch?.[1];
    if(documentId && documentMatch.index > text.lastIndexOf('[read-incoming-attachment]') && last?.role !== 'tool') {
      send({ tool_calls: [{ index: 0, id: 'call_read_document', type: 'function', function: { name: 'read_document', arguments: JSON.stringify({id:documentId}) } }] });
      finish('tool_calls'); return;
    }

    const historicalAttachment = /\[open-group-attachment:([a-f0-9-]+)\]/i.exec(text)?.[1];
    if (historicalAttachment && last?.role !== 'tool') {
      send({ tool_calls: [{ index: 0, id: 'call_open_attachment', type: 'function', function: { name: 'open_attachment', arguments: JSON.stringify({ id: historicalAttachment }) } }] });
      finish('tool_calls'); return;
    }
    let incomingPath;
    if (text.includes('[read-incoming-attachment]') && last?.role !== 'tool') {
      const attachmentContext = text.indexOf('本任务的附件已由服务器校验并准备到本任务专用的附件目录。');
      if (attachmentContext >= 0) {
        try { incomingPath = JSON.parse(text.slice(attachmentContext).split('\n')[1])[0]?.path; } catch {}
      }
    } else if (historicalAttachment && last?.tool_call_id === 'call_open_attachment') {
      try { incomingPath = JSON.parse(messageText(last.content).split('\n').at(-1)).path; } catch {}
    }
    if (incomingPath) {
      send({ tool_calls: [{ index: 0, id: 'call_read_incoming', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: incomingPath }) } }] });
      finish('tool_calls'); return;
    }

    if (text.includes('[slow-response]')) {
      send({ content: 'Starting slow reply ' });
      const timer = setInterval(() => send({ content: 'still working ' }), delayMs);
      res.on('close', () => clearInterval(timer));
      return;
    }

    const explicitRead = /\[read-path:([^\]]+)\]/.exec(text)?.[1];
    const attachmentPath = /\[attach-file:([^\]]+)\]/.exec(text)?.[1];
    if (attachmentPath && last?.role !== 'tool') {
      send({ tool_calls: [{ index: 0, id: 'call_attach_file', type: 'function', function: { name: 'attach_file', arguments: JSON.stringify({ path: attachmentPath }) } }] });
      finish('tool_calls'); return;
    }
    const scriptPath = /\[run-skill-script:([^\]]+)\]/.exec(text)?.[1];
    if (scriptPath && last?.role !== 'tool') {
      const tool = process.platform === 'win32' ? 'powershell' : 'bash';
      const quote = value => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
      const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(scriptPath)}`;
      send({ tool_calls: [{ index: 0, id: 'call_skill_script', type: 'function', function: { name: tool, arguments: JSON.stringify({ command, timeout: 20 }) } }] });
      finish('tool_calls'); return;
    }
    if ((text.includes('[read-workspace]') || text.includes('[read-outside]') || text.includes('[read-junction]') || explicitRead) && last?.role !== 'tool') {
      send({ tool_calls: [{ index: 0, id: 'call_read_fixture', type: 'function', function: { name: 'read', arguments: '' } }] });
      const requestedPath = explicitRead ?? (text.includes('[read-outside]') ? '../outside-secret.txt'
        : text.includes('[read-junction]') ? 'escape-junction/secret.txt' : readPath);
      send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: requestedPath }) } }] });
      finish('tool_calls');
      return;
    }

    const output = attachmentPath && text.includes('[omit-attachment-link]') && last?.role === 'tool'
      ? '文件已经生成，请查看结果。'
      : last?.role === 'tool'
      ? `File read through Pi: ${messageText(last.content)}`
      : text.includes('[resume-check]')
        ? `Resumed with ${messages.filter((message) => message.role === 'user').length} user messages.`
        : 'Pi SDK 已连接。本次回复来自本地集成测试模型。';
    // Multiple wire chunks exercise the actual SDK stream and the web SSE adapter.
    const midpoint = Math.max(1, Math.floor(output.length / 2));
    send({ content: output.slice(0, midpoint) });
    if (text.includes('[concurrent-response]')) {
      const timer = setTimeout(() => {
        send({ content: output.slice(midpoint) });
        finish();
      }, Math.max(delayMs, 120));
      res.on('close', () => clearTimeout(timer));
      return;
    }
    send({ content: output.slice(midpoint) });
    finish();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server, requests,
    url: `http://127.0.0.1:${address.port}`,
    get closedStreams() { return closedStreams; },
    async close() {
      for (const res of activeResponses) res.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
    },
  };
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
  return '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockProvider({
    port: Number(process.env.MOCK_PORT ?? 0),
    readPath: process.env.MOCK_READ_PATH ?? 'fixture.txt',
  });
  console.log(`Local test provider: ${mock.url}/v1 (test-model)`);
  const shutdown = async () => { await mock.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
