import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';
import { startMockProvider } from './mock-provider.mjs';

export async function createFixture({ prefix = 'auth', seed, options = {} } = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `pi-web-${prefix}-`));
  const workspace = path.join(tempDir, 'workspace');
  const dataDir = path.join(tempDir, 'data');
  await mkdir(workspace);
  await mkdir(dataDir);
  if (seed) await seed({ tempDir, workspace, dataDir });
  const mock = await startMockProvider();
  let server;
  let baseUrl;
  const fixture = {
    tempDir, workspace, dataDir, mock,
    get server() { return server; },
    get baseUrl() { return baseUrl; },
    client() { return createClient(() => baseUrl); },
    async start() {
      server = await createServer({ dataDir, defaultCwd: workspace, ...options });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    },
    async stop() {
      if (!server) return;
      const current = server;
      server = undefined;
      if (current.piWeb?.close) await current.piWeb.close();
      if (current.listening) await new Promise((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
      current.closeAllConnections();
    },
    async close() {
      await fixture.stop();
      await mock.close();
      assert.equal(path.dirname(path.resolve(tempDir)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(tempDir).startsWith(`pi-web-${prefix}-`));
      await rm(tempDir, { recursive: true, force: true });
    },
  };
  await fixture.start();
  return fixture;
}

export function createClient(getBaseUrl) {
  let cookie = '';
  const client = {
    get cookie() { return cookie; },
    set cookie(value) { cookie = value; },
    async fetch(route, { body, headers = {}, method = 'GET' } = {}) {
      const response = await fetch(`${getBaseUrl()}/api${route}`, {
        method,
        headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      const sessionCookie = response.headers.getSetCookie().find((entry) => entry.startsWith('pi_web_session='));
      if (sessionCookie) cookie = sessionCookie.split(';', 1)[0];
      return response;
    },
    async request(route, options) {
      const response = await client.fetch(route, options);
      const text = await response.text();
      return { response, data: text ? JSON.parse(text) : null };
    },
    async send(id, message, onEvent) {
      const response = await client.fetch(`/sessions/${id}/messages`, { method: 'POST', body: { message } });
      assert.equal(response.status, 200, response.ok ? '' : await response.text());
      return collectSSE(response, onEvent);
    },
  };
  return client;
}

export async function configure(client, fixture) {
  const result = await client.request('/config', { method: 'PUT', body: {
    provider: 'custom', model: 'test-model', baseUrl: `${fixture.mock.url}/v1`,
    apiKey: 'shared-test-model-key-do-not-return', cwd: fixture.workspace, mode: 'read-only',
    systemPrompt: 'Local SDK integration test. Use read only when requested.',
  } });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
}

export async function session(client, title) {
  const result = await client.request('/sessions', { method: 'POST', body: { title } });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return result.data.session;
}

export function deltaText(events) {
  return events.filter((event) => event.type === 'text_delta').map((event) => event.delta ?? event.text ?? '').join('');
}

export async function rawRequest(baseUrl, route, { method = 'GET', body, headers = {} } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      hostname: url.hostname, port: url.port, path: `/api${route}`, method,
      headers: { ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}), ...headers },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data: text ? JSON.parse(text) : null }));
    });
    request.on('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('Raw HTTP test timed out')));
    request.end(encoded);
  });
}

export async function collectSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let delimiter;
      while ((delimiter = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, delimiter.index);
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
        const json = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!json || json === '[DONE]') continue;
        const event = JSON.parse(json);
        events.push(event);
        onEvent?.(event);
      }
    }
    return events;
  } finally { reader.releaseLock(); }
}

// Explicit invitations for tests exercising collaboration within an existing group.
export async function inviteAll(client, id) {
  const users=(await client.request('/directory')).data.users;
  const result=await client.request(`/sessions/${id}/members`,{method:'POST',body:{userIds:users.map(user=>user.id)}});
  assert.equal(result.response.status,200,JSON.stringify(result.data));
}
export async function collaborativeSession(client,title) {
  const chat=await session(client,title);await inviteAll(client,chat.id);return chat;
}

// Explicitly seed an existing group from the period when members could create
// groups. This keeps legacy creator/membership coverage without bypassing the
// administrator-only creation policy on any application endpoint.
export async function legacySession(fixture, owner, title) {
  const account = (await owner.request('/auth/status')).data.user;
  assert.ok(account?.id, 'A logged-in historical group owner is required');
  const config = JSON.parse(await readFile(path.join(fixture.dataDir, 'config.json'), 'utf8'));
  const now = new Date().toISOString();
  const meta = { id: randomUUID(), title, createdAt: now, updatedAt: now, revision: 0,
    cwd: config.cwd, mode: config.mode, provider: config.provider, model: config.model,
    messageCount: 0, file: null, ownerId: account.id, workspaceId: 'company',
    legacyUnknownOwner: false, authorsMigrated: true };
  await fixture.stop();
  const database = new DatabaseSync(path.join(fixture.dataDir, 'workspace.sqlite'));
  try {
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO session_meta(id,data) VALUES (?,?)').run(meta.id, JSON.stringify(meta));
    database.prepare('INSERT INTO group_members VALUES (?,?,?,?)').run(meta.id, account.id, account.id, now);
    database.exec('COMMIT');
  } finally { database.close(); }
  await fixture.start();
  const response = await owner.request(`/sessions/${meta.id}`);
  assert.equal(response.response.status, 200, JSON.stringify(response.data));
  return response.data.session;
}

export async function legacyCollaborativeSession(fixture, owner, title) {
  const chat = await legacySession(fixture, owner, title);
  await inviteAll(owner, chat.id);
  return chat;
}
