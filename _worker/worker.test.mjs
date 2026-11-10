import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
import { weekStart, localNow, addDays } from './schedule.mjs';
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
test('GitHub Pages can book while the recipient stays server-configured', async () => {
  const origin = 'https://ilayshataniv-pixel.github.io';
  const bindings = { ...env(), PAGES_ORIGIN: origin };
  const preflight = await worker.fetch(new Request('https://example.com/api/booking', {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  }), bindings);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
  const privateRoute = await worker.fetch(new Request('https://example.com/api/account', { headers: { Origin: origin } }), bindings);
  assert.equal(privateRoute.headers.get('Access-Control-Allow-Origin'), null);

  const originalFetch = globalThis.fetch;
  const messages = [];
  globalThis.fetch = async (_url, options) => {
    messages.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  };
  try {
    const sent = await worker.fetch(request({ ...valid, contact: 'learner@example.com', chat_id: 'another-chat' }, origin), bindings);
    assert.equal(sent.status, 200);
    assert.equal(sent.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].chat_id, 'test-chat');
    assert.match(messages[0].text, /Контакт: learner@example.com/);
    assert.equal((await worker.fetch(request(valid, 'https://other.example'), bindings)).status, 403);
    assert.equal(messages.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
test('booking rejects unavailable time and sends the selected date with timezone', async () => {
  const week = weekStart(localNow('Asia/Irkutsk').slice(0,10));
  const date = addDays(week, 7);
  const data = { repeat:false,timeZone:'Asia/Irkutsk',template:[],weeks:{ [date]:[{day:0,time:'19:00',status:'free'}] } };
  const bindings = env(); bindings.DB = { prepare: () => ({ first: async () => ({ data:JSON.stringify(data),revision:1 }) }) };
  const originalFetch = globalThis.fetch; let sent = '';
  globalThis.fetch = async (_url, options) => { sent = JSON.parse(options.body).text; return Response.json({ok:true}); };
  try {
    assert.equal((await worker.fetch(request({...valid,slotDate:date,slotTime:'17:00'}),bindings)).status,409);
    assert.equal(sent,'');
    assert.equal((await worker.fetch(request({...valid,slotDate:date,slotTime:'19:00',lessonType:'trial'}),bindings)).status,200);
    assert.ok(sent.includes(date) && sent.includes('19:00') && sent.includes('Asia/Irkutsk') && sent.includes('Пробный урок'));
    data.weeks[date][0].status = 'taken';
    assert.equal((await worker.fetch(request({...valid,slotDate:date,slotTime:'19:00'}),bindings)).status,409);
  } finally { globalThis.fetch = originalFetch; }
});
