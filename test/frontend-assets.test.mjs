import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixture } from './auth-helpers.mjs';

describe('Vue production assets and legacy client compatibility', { concurrency: false }, () => {
  let fixture, frontendDir;
  before(async () => {
    const options = {};
    fixture = await createFixture({ prefix: 'frontend-assets', options, seed: async ({ tempDir }) => {
      options.publicDir = path.join(tempDir, 'public');
      frontendDir = options.frontendDir = path.join(tempDir, 'frontend', 'dist');
      await mkdir(options.publicDir);
      await mkdir(path.join(frontendDir, 'assets'), { recursive: true });
      await mkdir(path.join(tempDir, 'outside'));
      await writeFile(path.join(options.publicDir, 'index.html'), '<!doctype html><title>Legacy fixture</title><script type="module" src="/app.js"></script>');
      await writeFile(path.join(options.publicDir, 'app.js'), 'export const legacy = true;');
      await writeFile(path.join(frontendDir, 'index.html'), '<!doctype html><title>Vue fixture</title><script type="module" src="/assets/index-a1B2c3D4.js"></script>');
      await writeFile(path.join(frontendDir, 'assets', 'index-a1B2c3D4.js'), 'export const vue = true;');
      await writeFile(path.join(frontendDir, 'assets', 'plain.css'), 'body{color:black}');
      await writeFile(path.join(frontendDir, 'assets', 'avatar-a1B2c3D4.webp'), Buffer.from('RIFF-fixture-WEBP'));
      await writeFile(path.join(tempDir, 'outside', 'private-a1B2c3D4.js'), 'outside-private-marker');
      await symlink(path.join(tempDir, 'outside'), path.join(frontendDir, 'assets', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } });
  });
  after(async () => { await fixture?.close(); });

  it('serves Vue by default and retains legacy entry points and root modules under the same CSP', async () => {
    const current = await fetch(`${fixture.baseUrl}/`);
    assert.equal(current.status, 200);
    assert.match(await current.text(), /Vue fixture/);
    assert.equal(current.headers.get('cache-control'), 'no-cache');
    const policy = current.headers.get('content-security-policy');
    assert.match(policy, /script-src 'self';/);
    assert.match(policy, /connect-src 'self';/);
    assert.match(policy, /frame-ancestors 'none'/);
    for (const route of ['/legacy', '/legacy/', '/legacy/index.html']) {
      const response = await fetch(`${fixture.baseUrl}${route}`);
      assert.equal(response.status, 200, route);
      assert.match(await response.text(), /Legacy fixture/);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.equal(response.headers.get('content-security-policy'), policy);
    }
    for (const route of ['/app.js', '/legacy/app.js']) {
      const response = await fetch(`${fixture.baseUrl}${route}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /legacy = true/);
      assert.match(response.headers.get('content-type'), /javascript/);
    }
    const head = await fetch(`${fixture.baseUrl}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get('content-length')) > 0);
    assert.equal(await head.text(), '');
  });

  it('caches only hashed build assets immutably and preserves SPA navigation and API responses', async () => {
    const asset = await fetch(`${fixture.baseUrl}/assets/index-a1B2c3D4.js?v=fixture`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(await asset.text(), /vue = true/);
    assert.match(asset.headers.get('content-type'), /javascript/);
    const portrait = await fetch(`${fixture.baseUrl}/assets/avatar-a1B2c3D4.webp`);
    assert.equal(portrait.status, 200);
    assert.equal(portrait.headers.get('content-type'), 'image/webp');
    assert.equal(portrait.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(portrait.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await portrait.text(), 'RIFF-fixture-WEBP');
    const plain = await fetch(`${fixture.baseUrl}/assets/plain.css`);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get('cache-control'), 'no-cache');
    const navigation = await fetch(`${fixture.baseUrl}/groups/group-fixture`);
    assert.equal(navigation.status, 200);
    assert.match(await navigation.text(), /Vue fixture/);
    for (const route of ['/assets/missing-a1B2c3D4.js', '/missing.js', '/api']) {
      const response = await fetch(`${fixture.baseUrl}${route}`);
      assert.equal(response.status, 404, route);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-type'), /application\/json/);
    }
    const auth = await fetch(`${fixture.baseUrl}/api/auth/status`);
    assert.equal(auth.status, 200);
    assert.equal((await auth.json()).authenticated, false);
    const privateApi = await fetch(`${fixture.baseUrl}/api/sessions`);
    assert.equal(privateApi.status, 401);
  });

  it('rejects traversal and symlink escapes without turning them into SPA navigation', async () => {
    const raw = (route) => new Promise((resolve, reject) => {
      const url = new URL(fixture.baseUrl);
      http.get({ hostname: url.hostname, port: url.port, path: route }, (response) => {
        let body = '';
        response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
      }).on('error', reject);
    });
    for (const route of ['/../outside/private-a1B2c3D4.js', '/legacy/%2e%2e/outside', '/assets/%5c..%5cprivate.js', '/assets/%00bad', '/assets/escape/private-a1B2c3D4.js']) {
      const result = await raw(route);
      assert.equal(result.status, 403, route);
      assert.ok(!result.body.includes('outside-private-marker'));
      assert.equal(result.headers['cache-control'], 'no-store');
    }
    assert.equal((await raw('/assets/%not-valid')).status, 400);
  });

  it('uses the legacy application when no production build is present', async () => {
    await rm(path.join(frontendDir, 'index.html'));
    const response = await fetch(`${fixture.baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Legacy fixture/);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  });
});
