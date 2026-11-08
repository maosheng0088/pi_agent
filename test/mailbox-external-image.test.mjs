import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fetchMailboxExternalImage } from '../lib/mailbox-external-image.mjs';

const publicHost = 'images.example.com';
const imageUrl = `https://${publicHost}/mail/image.png?size=small`;
const publicV4 = { address: '8.8.8.8', family: 4 };
const publicV6 = { address: '2606:4700::1111', family: 6 };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM0sAAAAASUVORK5CYII=', 'base64');

function fixture({ records = [publicV4], statusCode = 200, headers = { 'content-type': 'image/png' }, chunks = [png] } = {}) {
  const calls = { lookup: [], request: [] };
  return { calls, options: {
    async lookup(hostname) { calls.lookup.push(hostname); return records; },
    request(options, done) {
      calls.request.push(options);
      const req = new EventEmitter();
      req.end = () => done(Object.assign(Readable.from(chunks), { statusCode, headers, complete: true }));
      return req;
    },
  } };
}

test('external image pins one validated address and keeps TLS identity on the DNS hostname', async () => {
  const { options, calls } = fixture({ records: [publicV6, publicV4], headers: { 'content-type': 'Image/PNG; charset=binary', 'content-length': String(png.length) } });
  assert.deepEqual(await fetchMailboxExternalImage(imageUrl, options), { content: png, mimeType: 'image/png' });
  assert.deepEqual(calls.lookup, [publicHost]);
  const [request] = calls.request;
  assert.equal(request.hostname, publicHost);
  assert.equal(request.servername, publicHost);
  assert.equal(request.path, '/mail/image.png?size=small');
  assert.equal(request.method, 'GET');
  assert.equal(request.port, 443);
  assert.equal(request.rejectUnauthorized, true);
  assert.equal(request.minVersion, 'TLSv1.2');
  assert.equal(request.autoSelectFamily, false);
  assert.equal(request.family, 4);
  assert.deepEqual(request.agent.options.proxyEnv, {});
  assert.deepEqual(Object.keys(request.headers), ['Accept', 'Accept-Encoding']);
  request.lookup(publicHost, { all: false }, (error, address, family) => {
    assert.equal(error, null);
    assert.deepEqual({ address, family }, publicV4);
  });
  request.lookup(publicHost, { all: true }, (error, records) => {
    assert.equal(error, null);
    assert.deepEqual(records, [publicV4]);
  });
  request.lookup('different.example.com', {}, error => assert.equal(error.status, 422));
  assert.equal(calls.request.length, 1);

  const ipv6 = fixture({ records: [publicV6] });
  await fetchMailboxExternalImage(imageUrl, ipv6.options);
  ipv6.calls.request[0].lookup(publicHost, {}, (error, address, family) => {
    assert.equal(error, null);
    assert.deepEqual({ address, family }, publicV6);
  });
});

test('invalid destinations are blocked before DNS or HTTP', async () => {
  const { options, calls } = fixture();
  for (const value of [
    `http://${publicHost}/a`, `https://person:secret@${publicHost}/a`, `https://@${publicHost}/a`, `https://${publicHost}:8443/a`,
    'https://0x7f000001/a', 'https://127.1/a', 'https://[::1]/a', 'https://169.254.169.254/a', 'https://cloud.local/a',
    'https://host.internal/a', 'https://router.home.arpa/a', 'https://singlelabel/a', `https://${publicHost}\\other/a`,
  ]) await assert.rejects(fetchMailboxExternalImage(value, options), error => [400, 422].includes(error.status));
  assert.deepEqual(calls, { lookup: [], request: [] });
});

test('one non-public or malformed A or AAAA record blocks all connections', async () => {
  for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.0.2.3', '192.168.0.1', '198.18.0.1', '203.0.113.2', '224.1.1.1', '255.255.255.255']) {
    const { options, calls } = fixture({ records: [publicV6, { address, family: 4 }] });
    await assert.rejects(fetchMailboxExternalImage(imageUrl, options), { status: 422 });
    assert.equal(calls.request.length, 0);
  }
  for (const address of ['::', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2001::1', '2001:db8::1', '2002:7f00:1::1',
    '3000::1', '3ffe::1', '3fff::1', 'fc00::1', 'fe80::1%eth0', 'ff02::1']) {
    const { options, calls } = fixture({ records: [publicV4, { address, family: 6 }] });
    await assert.rejects(fetchMailboxExternalImage(imageUrl, options), { status: 422 });
    assert.equal(calls.request.length, 0);
  }
  const malformed = fixture({ records: [publicV4, { address: publicV6.address, family: 4 }] });
  await assert.rejects(fetchMailboxExternalImage(imageUrl, malformed.options), { status: 422 });
  assert.equal(malformed.calls.request.length, 0);
});

test('external image never follows redirects and rejects unsupported, spoofed, or encoded data', async () => {
  const redirected = fixture({ statusCode: 302, headers: { location: 'https://other.example.com/a' } });
  await assert.rejects(fetchMailboxExternalImage(imageUrl, redirected.options), { status: 502 });
  assert.deepEqual(redirected.calls.lookup, [publicHost]);
  assert.equal(redirected.calls.request.length, 1);
  for (const bad of [
    { headers: { 'content-type': 'image/svg+xml' } },
    { headers: { 'content-type': 'text/html' } },
    { headers: { 'content-type': 'image/jpeg' } },
    { headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' } },
    { chunks: [Buffer.from('<html>not an image</html>')] },
  ]) await assert.rejects(fetchMailboxExternalImage(imageUrl, fixture(bad).options), { status: 415 });
});

test('external image rejects oversized or truncated replies even when Content-Length is missing', async () => {
  const limit = 4 * 1024 * 1024;
  const oversized = fixture({ headers: { 'content-type': 'image/png', 'content-length': String(limit + 1) } });
  await assert.rejects(fetchMailboxExternalImage(imageUrl, oversized.options), { status: 413 });
  const chunked = fixture({ chunks: [png, Buffer.alloc(limit)] });
  await assert.rejects(fetchMailboxExternalImage(imageUrl, chunked.options), { status: 413 });
  const truncated = fixture({ headers: { 'content-type': 'image/png', 'content-length': String(png.length + 1) } });
  await assert.rejects(fetchMailboxExternalImage(imageUrl, truncated.options), { status: 502 });
});

test('external image validates bounded raster dimensions for the four allowed formats', async () => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const jpeg = Buffer.from('ffd8ffe000040102ffc0000b080001000101011100ffda', 'hex');
  const webp = Buffer.alloc(30);
  webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16);
  for (const [mimeType, content, oversize] of [
    ['image/png', png, value => { value.writeUInt32BE(6000, 16); value.writeUInt32BE(6000, 20); }],
    ['image/gif', gif, value => value.writeUInt16LE(8193, 6)],
    ['image/jpeg', jpeg, value => value.writeUInt16BE(8193, 15)],
    ['image/webp', webp, value => value.writeUIntLE(8192, 24, 3)],
  ]) {
    const headers = { 'content-type': mimeType };
    assert.deepEqual(await fetchMailboxExternalImage(imageUrl, fixture({ headers, chunks: [content] }).options), { content, mimeType });
    const large = Buffer.from(content);
    oversize(large);
    await assert.rejects(fetchMailboxExternalImage(imageUrl, fixture({ headers, chunks: [large] }).options), { status: 413 });
    await assert.rejects(fetchMailboxExternalImage(imageUrl, fixture({ headers, chunks: [content.subarray(0, 8)] }).options), { status: 415 });
  }
});

test('external image deadline includes DNS and caller cancellation does not start HTTPS', async () => {
  const { options, calls } = fixture();
  let lookupSignal;
  const lookup = (_hostname, { signal }) => { lookupSignal = signal; return new Promise(() => {}); };
  await assert.rejects(fetchMailboxExternalImage(imageUrl, { ...options, lookup, timeoutMs: 10 }), { status: 504 });
  assert.equal(lookupSignal.aborted, true);
  const controller = new AbortController();
  const work = fetchMailboxExternalImage(imageUrl, { ...options, lookup, signal: controller.signal });
  controller.abort();
  await assert.rejects(work, { status: 499 });
  assert.equal(calls.request.length, 0);
});
