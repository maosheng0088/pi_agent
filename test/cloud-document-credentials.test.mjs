import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CloudCredentialVault, windowsCredentialCodec } from '../lib/cloud-document-credentials.mjs';

export function fixtureCodec() {
  const key = randomBytes(32);
  return async (operation, bytes) => {
    if (operation === 'protect') { const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv); const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]); }
    const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]);
  };
}
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pi-cloud-vault-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('pi-cloud-vault-'));await fs.rm(directory,{recursive:true,force:true});});
  return {directory,vault:await CloudCredentialVault.open(directory,{codec:fixtureCodec()})};
}
test('vault encrypts disk content, validates inputs and preserves optional WPS fields',async t=>{
  const {directory,vault}=await fixture(t);
  await vault.update('tencent',{token:'fixture-secret-TENCENT-8271'});
  await vault.update('wps365',{clientId:'fixture-client-931',clientSecret:'fixture-secret-WPS-3721'});
  await vault.update('wps365',{clientId:'changed-client-812'});
  assert.equal(vault.get('wps365').clientSecret,'fixture-secret-WPS-3721');
  assert.equal(vault.get('wps365').clientId,'changed-client-812');
  const raw=await fs.readFile(vault.file,'utf8');assert.doesNotMatch(raw,/fixture-secret|changed-client/);
  assert.deepEqual((await CloudCredentialVault.open(directory,{codec:vault.codec})).get('tencent'),vault.get('tencent'));
  for(const [provider,value] of [['unknown',{token:'x'}],['tencent',{token:'bad\r\nheader'}],['kdocs',{token:'x',endpoint:'https://evil.example'}],['wps365',{clientId:'x'.repeat(201)}]]) await assert.rejects(async()=>vault.update(provider,value));
  await vault.clear('tencent');assert.equal(vault.get('tencent'),null);
  assert.ok(vault.knownSecrets().includes('fixture-secret-TENCENT-8271'),'old secrets remain available for in-flight error redaction');
});
test('vault serializes changes and cannot commit after authorization is revoked during encryption',async t=>{
  const {vault}=await fixture(t);let allowed=true;const original=vault.codec;
  vault.codec=async(...args)=>{const result=await original(...args);allowed=false;return result;};
  await assert.rejects(vault.update('kdocs',{token:'new-secret-7331'},{authorize:()=>{if(!allowed)throw new Error('revoked');}}),/revoked/);
  assert.equal(vault.get('kdocs'),null);assert.equal(vault.version('kdocs'),0);
});
test('Windows credential codec roundtrips with CurrentUser protection', {skip:process.platform!=='win32',timeout:30000},async()=>{
  const bytes=Buffer.from('only-fixture-secret-DPAPI-8239'),cipher=await windowsCredentialCodec('protect',bytes);
  assert.ok(!cipher.includes(bytes));assert.deepEqual(await windowsCredentialCodec('unprotect',cipher),bytes);
});
