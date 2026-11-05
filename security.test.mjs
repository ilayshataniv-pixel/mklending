import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
test('all responses including failures carry security headers', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/config'), { TELEGRAM_BOT_TOKEN:'server-only',TELEGRAM_CHAT_ID:'private-chat' });
  assert.equal(response.headers.get('X-Frame-Options'),'DENY');
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  assert.ok(response.headers.get('Content-Security-Policy').includes("script-src 'self'"));
  const body = await response.text(); assert.ok(!body.includes('server-only') && !body.includes('private-chat'));
  const failure = await worker.fetch(new Request('https://example.com/api/booking',{method:'POST',headers:{Origin:'https://evil.example'}}),{});
  assert.equal(failure.status,403); assert.equal(failure.headers.get('X-Frame-Options'),'DENY');
});
test('static admin pages are not cached and runtime errors reveal no details', async () => {
  const response = await worker.fetch(new Request('https://example.com/admin.html'),{ASSETS:{fetch:async()=>new Response('<html></html>')}});
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(response.headers.get('X-Robots-Tag'),'noindex, nofollow');
  const failure = await worker.fetch(new Request('https://example.com/'),{ASSETS:{fetch:async()=>{throw new Error('private internal error');}}});
  assert.equal(failure.status,503); assert.ok(!(await failure.text()).includes('private'));
});
test('insecure requests redirect to HTTPS without processing submitted data', async () => {
  const response = await worker.fetch(new Request('http://example.com/api/config'),{});
  assert.equal(response.status,308); assert.equal(response.headers.get('Location'),'https://example.com/api/config');
});
test('message field injection and invalid content types are rejected', async () => {
  const env = {TELEGRAM_BOT_TOKEN:'test',TELEGRAM_CHAT_ID:'test',BOOKING_LIMITER:{limit:async()=>({success:true})}};
  const data = {name:'Name\nFake field',contact:'@example',goal:'Для работы',message:'',consent:'on',website:''};
  const headers = {Origin:'https://example.com','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'};
  const request = () => new Request('https://example.com/api/booking',{method:'POST',headers,body:JSON.stringify(data)});
  assert.equal((await worker.fetch(request(),env)).status,400);
  headers['Content-Type'] = 'application/json-invalid';
  assert.equal((await worker.fetch(request(),env)).status,415);
});
test('secret scanner fails without printing credential values', async () => {
  const directory = await mkdtemp(path.join(tmpdir(),'mklending-security-'));
  const fakeToken = '123456789' + ':' + 'A'.repeat(35);
  try {
    await copyFile(new URL('./check-secrets.mjs',import.meta.url),path.join(directory,'check-secrets.mjs'));
    await writeFile(path.join(directory,'leak.js'),`const token = '${fakeToken}';`);
    await assert.rejects(promisify(execFile)(process.execPath,[path.join(directory,'check-secrets.mjs')]), error => error.code === 1 && error.stderr.includes('leak.js') && !error.stderr.includes(fakeToken) && !error.stdout.includes(fakeToken));
  } finally {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('mklending-security-')) throw new Error('Invalid temporary path');
    await rm(directory,{recursive:true,force:true});
  }
});
