import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
const valid = { name: 'Тест', contact: '@example', goal: 'Для работы', message: '', consent: 'on', website: '' };
const env = () => ({ TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat', BOOKING_LIMITER: { limit: async () => ({ success: true }) } });
const request = (data = valid, origin = 'https://example.com') => new Request('https://example.com/api/booking', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: JSON.stringify(data) });
test('configuration never exposes secrets and disables unconfigured booking', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/config'), {});
  assert.equal((await response.json()).bookingEnabled, false);
  const configured = await worker.fetch(new Request('https://example.com/api/config'), env());
  const content = await configured.text();
  assert.ok(!content.includes('test-token') && !content.includes('test-chat'));
});
test('cross-origin requests, absent consent and oversized input are rejected', async () => {
  assert.equal((await worker.fetch(request(valid, 'https://other.example'), env())).status, 403);
  assert.equal((await worker.fetch(request({ ...valid, consent: '' }), env())).status, 400);
  assert.equal((await worker.fetch(request({ ...valid, message: 'x'.repeat(9000) }), env())).status, 413);
  assert.equal((await worker.fetch(request(null), env())).status, 400);
});
test('rate limit and missing configuration prevent sending', async () => {
  assert.equal((await worker.fetch(request(), {})).status, 503);
  const bindings = env(); bindings.BOOKING_LIMITER.limit = async () => ({ success: false });
  assert.equal((await worker.fetch(request(), bindings)).status, 429);
});
test('honeypot does not send and Telegram must confirm success', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_url, options) => { calls++; assert.equal(JSON.parse(options.body).chat_id, 'test-chat'); return Response.json({ ok: true }); };
  try {
    assert.equal((await worker.fetch(request({ ...valid, website: 'spam' }), env())).status, 200);
    assert.equal(calls, 0);
    assert.equal((await worker.fetch(request(), env())).status, 200);
    assert.equal(calls, 1);
    globalThis.fetch = async () => Response.json({ ok: false });
    assert.equal((await worker.fetch(request(), env())).status, 502);
  } finally { globalThis.fetch = originalFetch; }
});
