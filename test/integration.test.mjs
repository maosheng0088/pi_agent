import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';
import { startMockProvider } from './mock-provider.mjs';

describe('Pi Web with the real local Pi SDK', { timeout: 120_000, concurrency: false }, () => {
  let tempDir;
  let workspace;
  let dataDir;
  let mock;
  let server;
  let baseUrl;
  let retainedSession;
  let authCookie = '';
  const adminPassword = 'Pi-integration-admin-123!';
  const fixtureContent = 'workspace-fixture-7cd6a1: 本文件由真实 Pi read 工具读取。\n';

  async function startApp() {
    server = await createServer({ dataDir, defaultCwd: workspace });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }

  async function stopApp() {
    if (!server) return;
    const current = server;
    server = undefined;
    if (current.piWeb?.close) await current.piWeb.close();
    if (current.listening) {
      await new Promise((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
    }
    current.closeAllConnections();
  }

  async function api(route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}/api${route}`, {
      method,
      headers: { ...(authCookie ? { cookie: authCookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const setCookie = response.headers.getSetCookie().find((item) => item.startsWith('pi_web_session='));
    if (setCookie) authCookie = setCookie.split(';', 1)[0];
    const text = await response.text();
    return { response, data: text ? JSON.parse(text) : null };
  }

  async function newSession(options = {}) {
    const { response, data } = await api('/sessions', {
      method: 'POST', body: { title: 'Integration test', ...options },
    });
    assert.ok(response.status === 200 || response.status === 201, JSON.stringify(data));
    assert.equal(typeof data.session?.id, 'string');
    return data.session;
  }

  async function send(id, message, onEvent) {
    const response = await fetch(`${baseUrl}/api/sessions/${id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authCookie ? { cookie: authCookie } : {}) },
      body: JSON.stringify({ message }), signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200, await errorBody(response));
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    return collectSSE(response, onEvent);
  }

  before(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-web-integration-'));
    workspace = path.join(tempDir, 'workspace');
    dataDir = path.join(tempDir, 'data');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'fixture.txt'), fixtureContent, 'utf8');
    mock = await startMockProvider();
    await startApp();
    const setup = await api('/auth/setup', { method: 'POST', body: {
      username: 'integration-admin', displayName: 'Integration Admin', password: adminPassword,
    } });
    assert.ok([200, 201].includes(setup.response.status), JSON.stringify(setup.data));
    assert.ok(authCookie, 'Setup should establish an authenticated admin session');
  });

  after(async () => {
    await stopApp();
    await mock?.close();
    if (tempDir) {
      assert.equal(path.dirname(path.resolve(tempDir)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(tempDir).startsWith('pi-web-integration-'));
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports runtime status and saves provider config without exposing the API key', async () => {
    const status = await api('/status');
    assert.equal(status.response.status, 200);
    const models = await api('/models');
    assert.equal(models.response.status, 200);

    const saved = await api('/config', { method: 'PUT', body: {
      provider: 'custom', model: 'test-model', baseUrl: `${mock.url}/v1`,
      apiKey: 'local-test-key-do-not-return', cwd: workspace, mode: 'read-only',
      systemPrompt: 'You are a local integration test assistant. Use read when asked.',
    } });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.data));
    assert.ok(!JSON.stringify(saved.data).includes('local-test-key-do-not-return'));
    const loaded = await api('/config');
    assert.equal(loaded.response.status, 200);
    assert.ok(!JSON.stringify(loaded.data).includes('local-test-key-do-not-return'));
    assert.ok(JSON.stringify(loaded.data).includes('test-model'));
  });

  it('streams an actual SDK response and stores user and assistant messages', async () => {
    retainedSession = await newSession({ title: 'Persistent conversation' });
    const events = await send(retainedSession.id, 'Remember marker original-user-9a16.');
    assert.equal(events[0]?.type, 'start');
    const deltas = events.filter((event) => event.type === 'text_delta');
    assert.ok(deltas.length >= 2, JSON.stringify(events));
    assert.match(deltas.map(deltaText).join(''), /Pi SDK 已连接/);
    assert.ok(events.some((event) => event.type === 'done'), JSON.stringify(events));
    assert.ok(!events.some((event) => event.type === 'error'), JSON.stringify(events));
    assert.equal(mock.requests.at(-1).stream, true);
    assert.equal(mock.requests.at(-1).model, 'test-model');
    const detail = await api(`/sessions/${retainedSession.id}`);
    assert.equal(detail.response.status, 200);
    assert.match(JSON.stringify(detail.data), /original-user-9a16/);
    assert.match(JSON.stringify(detail.data), /Pi SDK 已连接/);
  });

  it('executes the built-in read tool against a real workspace file', async () => {
    const session = await newSession({ title: 'Read fixture' });
    await writeFile(path.join(session.cwd, 'fixture.txt'), fixtureContent, 'utf8');
    const beforeRequests = mock.requests.length;
    const events = await send(session.id, 'Please [read-workspace] and quote the file.');
    const toolEvents = events.filter((event) => event.type.startsWith('tool_'));
    assert.ok(toolEvents.some((event) => event.type === 'tool_start'), JSON.stringify(events));
    assert.ok(toolEvents.some((event) => event.type === 'tool_end'), JSON.stringify(events));
    assert.match(events.filter((event) => event.type === 'text_delta').map(deltaText).join(''), /workspace-fixture-7cd6a1/);
    assert.ok(mock.requests.length >= beforeRequests + 2, 'Tool results must return to the real model loop');
    const followupRequest = mock.requests.at(-1);
    assert.ok(followupRequest.messages.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('workspace-fixture-7cd6a1')));
    assert.ok(followupRequest.tools.some((tool) => tool.function.name === 'read'));
    assert.ok(!followupRequest.tools.some((tool) => ['bash', 'powershell', 'write', 'edit'].includes(tool.function.name)));
    assert.equal(toolEvents.find((event) => event.type === 'tool_end')?.isError, false);
    assert.ok(events.some((event) => event.type === 'done'));
    assert.equal(await readFile(path.join(workspace, 'fixture.txt'), 'utf8'), fixtureContent);
  });

  it('reloads persisted sessions after a server restart and resumes their context', async () => {
    assert.ok(retainedSession, 'Previous chat must have completed');
    await stopApp();
    await startApp();
    const login = await api('/auth/login', { method: 'POST', body: { username: 'integration-admin', password: adminPassword } });
    assert.equal(login.response.status, 200, JSON.stringify(login.data));
    const list = await api('/sessions');
    assert.equal(list.response.status, 200);
    assert.match(JSON.stringify(list.data), new RegExp(retainedSession.id));
    const detail = await api(`/sessions/${retainedSession.id}`);
    assert.equal(detail.response.status, 200);
    assert.match(JSON.stringify(detail.data), /original-user-9a16/);
    const events = await send(retainedSession.id, '[resume-check] What have we discussed?');
    assert.ok(events.some((event) => event.type === 'done'), JSON.stringify(events));
    const latestRequest = mock.requests.at(-1);
    assert.ok(latestRequest.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('original-user-9a16')));
    assert.ok(latestRequest.messages.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('Pi SDK 已连接')));
  });

  it('aborts a streaming model request and leaves the session usable', async () => {
    const session = await newSession({ title: 'Abort then continue' });
    let abortRequest;
    const events = await send(session.id, '[slow-response] keep streaming', (event) => {
      if (event.type === 'text_delta' && !abortRequest) {
        abortRequest = api(`/sessions/${session.id}/abort`, { method: 'POST', body: {} });
      }
    });
    assert.ok(abortRequest, 'At least one streamed delta should arrive before cancelling');
    const aborted = await abortRequest;
    assert.equal(aborted.response.status, 200, JSON.stringify(aborted.data));
    assert.equal(events.find((event) => event.type === 'done')?.aborted, true, JSON.stringify(events));
    const next = await send(session.id, 'Continue with a regular response.');
    assert.match(next.filter((event) => event.type === 'text_delta').map(deltaText).join(''), /Pi SDK 已连接/);
    assert.ok(next.some((event) => event.type === 'done'));
  });

  it('rejects malformed configuration, messages and session input', async () => {
    for (const body of [
      { provider: 'custom', model: '', baseUrl: `${mock.url}/v1` },
      { provider: 'custom', model: 'test-model', baseUrl: 'file:///etc/passwd' },
      { mode: 'unsafe-unknown-mode' },
    ]) {
      const result = await api('/config', { method: 'PUT', body });
      assert.equal(result.response.status, 400, JSON.stringify(result.data));
    }
    const invalid = await api('/sessions', { method: 'POST', body: { cwd: path.join(workspace, 'does-not-exist') } });
    assert.ok([400, 403].includes(invalid.response.status), JSON.stringify(invalid.data));
    const session = await newSession();
    const empty = await api(`/sessions/${session.id}/messages`, { method: 'POST', body: { message: '' } });
    assert.equal(empty.response.status, 400, JSON.stringify(empty.data));
    const missing = await api('/sessions/not-a-session');
    assert.ok([400, 404].includes(missing.response.status), JSON.stringify(missing.data));
  });

  it('rejects a cross-origin mutation before it can create a session', async () => {
    const beforeList = await api('/sessions');
    const forbidden = await api('/sessions', {
      method: 'POST', body: { title: 'Cross-origin injection', cwd: workspace },
      headers: { origin: 'https://untrusted.example' },
    });
    assert.equal(forbidden.response.status, 403, JSON.stringify(forbidden.data));
    const afterList = await api('/sessions');
    assert.deepEqual(afterList.data, beforeList.data);
  });
});

function deltaText(event) {
  return event.delta ?? event.text ?? '';
}

async function errorBody(response) {
  return response.ok ? '' : await response.text();
}

async function collectSSE(response, onEvent) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parseFrame = (frame) => {
    const lines = frame.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const parsed = JSON.parse(data);
    const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const event = { ...parsed, type: parsed.type ?? eventName };
    events.push(event);
    onEvent?.(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let delimiter;
      while ((delimiter = /\r?\n\r?\n/.exec(buffer))) {
        parseFrame(buffer.slice(0, delimiter.index));
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) parseFrame(buffer);
    return events;
  } finally {
    reader.releaseLock();
  }
}
