import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { testDatabase } from './database-fixture.mjs';
import worker from './worker.mjs';
import { localNow, addDays, weekStart } from './schedule.mjs';

const origin = 'https://example.com';
const credentials = { email: ' learner@example.test ', credential: 'ab'.repeat(32) };

function setup(t) {
  const { db, binding } = testDatabase(t);
  const env = {
    ASSETS: { fetch: async () => new Response('Account page') },
    AUTH_LIMITER: { limit: async () => ({ success: true }) },
    ACCOUNT_PEPPER: '4a'.repeat(32),
    DB: binding,
  };
  function call(path, { method = 'GET', body, cookie, from = origin, ctx } = {}) {
    const headers = { Origin: from, 'CF-Connecting-IP': '192.0.2.1' };
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    return worker.fetch(new Request(origin + path, { method, headers, body: JSON.stringify(body) }), env, ctx);
  }
  const register = body => call('/api/account/register', { method: 'POST', body: { ...credentials, name: 'Анна', ...body } });
  return { db, env, call, register };
}

test('register, protect the cabinet, rename, log out, and sign in with the saved name', async t => {
  const { db, call, register } = setup(t);
  assert.equal((await call('/api/account')).status, 401);
  for (const path of ['/account', '/account/', '/account.html', '/%61ccount.html']) {
    const guest = await call(path);
    assert.equal(guest.status, 303);
    assert.equal(guest.headers.get('Location'), '/auth.html');
    assert.equal(guest.headers.get('Cache-Control'), 'no-store');
  }
  const registered = await register();
  assert.equal(registered.status, 201);
  assert.deepEqual((await registered.json()).profile, { name: 'Анна', email: 'learner@example.test' });
  const session = registered.headers.get('Set-Cookie');
  assert.match(session, /^__Host-maria_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  const cookie = session.split(';')[0];
  const savedPassword = db.prepare('SELECT password_hash FROM users').get().password_hash;
  assert.match(savedPassword, /^v2:[a-f0-9]{64}$/);
  assert.notEqual(savedPassword.slice(3), credentials.credential);
  const savedToken = db.prepare('SELECT token_hash FROM sessions').get().token_hash;
  assert.match(savedToken, /^[a-f0-9]{64}$/);
  assert.ok(!cookie.includes(savedToken));
  const cabinet = await call('/account.html', { cookie });
  assert.equal(cabinet.status, 200);
  assert.equal(cabinet.headers.get('Cache-Control'), 'no-store');
  const update = await call('/api/account', { method: 'PATCH', cookie, body: { name: '  Анна П.  ' } });
  assert.equal((await update.json()).profile.name, 'Анна П.');
  const logout = await call('/api/account/logout', { method: 'POST', cookie });
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await call('/api/account', { cookie })).status, 401);
  assert.equal((await call('/api/account/login', { method: 'POST', body: { ...credentials, credential: 'cd'.repeat(32) } })).status, 401);
  const login = await call('/api/account/login', { method: 'POST', body: { ...credentials, email: 'LEARNER@EXAMPLE.TEST' } });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).profile.name, 'Анна П.');
  assert.notEqual(login.headers.get('Set-Cookie').split(';')[0], cookie);
});

test('parallel registration creates one normalized email and one session', async t => {
  const { db, register } = setup(t);
  const responses = await Promise.all([register(), register({ email: 'LEARNER@EXAMPLE.TEST' })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM users').get().total, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM sessions').get().total, 1);
});

test('a legacy account can sign in and upgrade to the new verifier', async t => {
  const { db, call } = setup(t);
  const password = 'legacy password';
  const salt = '24'.repeat(16);
  const hash = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 600_000, 32, 'sha256').toString('hex');
  db.prepare('INSERT INTO users (id, email, name, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run('legacy', credentials.email.trim(), 'Анна', salt, hash);
  const path = '/api/account/login';
  const needsPassword = await call(path, { method: 'POST', body: credentials });
  assert.equal(needsPassword.status, 409);
  assert.equal((await needsPassword.json()).error, 'legacy_credentials');
  assert.equal((await call(path, { method: 'POST', body: { ...credentials, password } })).status, 200);
  assert.match(db.prepare('SELECT password_hash FROM users').get().password_hash, /^v2:/);
  assert.equal((await call(path, { method: 'POST', body: credentials })).status, 200);
});

test('account mutations check origin, session expiration, and login rate limits', async t => {
  const { db, env, call, register } = setup(t);
  const registered = await register();
  const cookie = registered.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await call('/api/account', { method: 'PATCH', cookie, body: { name: 'Анна' }, from: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/account/logout', { method: 'POST', cookie, from: 'https://evil.example' })).status, 403);
  db.exec('UPDATE sessions SET expires_at = 0');
  assert.equal((await call('/api/account', { cookie })).status, 401);
  assert.equal((await call('/api/account', { method: 'PATCH', cookie, body: { name: 'Анна' } })).status, 401);
  env.AUTH_LIMITER.limit = async () => ({ success: false });
  assert.equal((await call('/api/account/login', { method: 'POST', body: credentials })).status, 429);
});

test('password recovery conceals account existence and consumes each link once', async t => {
  const { db, env, call, register } = setup(t);
  const recovery = '/api/account/recovery';
  const reset = '/api/account/reset';
  const login = '/api/account/login';
  const email = credentials.email.trim();
  const otherEmail = 'other@example.test';
  const post = (path, body, options) => call(path, { method: 'POST', body, ...options });
  const page = await call('/recovery.html');
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  assert.equal(page.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal((await post(recovery, { email })).status, 503);
  Object.assign(env, {
    RESET_ORIGIN: origin,
    RESET_FROM_EMAIL: 'sender@example.test',
    RESET_MAIL_API_KEY: 'mail-test',
  });
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    sent.push({ url, ...JSON.parse(options.body).message });
    return Response.json({ status: 'success', emails: [email] });
  });
  const session = async response => (await response).headers.get('Set-Cookie').split(';')[0];
  const oldSession = await session(register());
  const secondSession = await session(post(login, credentials));
  const otherSession = await session(register({ email: otherEmail }));
  assert.equal((await post(recovery, { email }, { from: 'https://evil.example' })).status, 403);
  const deliveries = [];
  const ctx = { waitUntil: promise => deliveries.push(promise) };
  for (const address of ['unknown@example.test', ' LEARNER@EXAMPLE.TEST ', email]) {
    const response = await post(recovery, { email: address }, { ctx });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true });
  }
  await Promise.all(deliveries);
  assert.equal(deliveries.length, 3);
  assert.equal(sent.length, 1);
  const [message] = sent;
  assert.equal(message.url, 'https://goapi.unisender.ru/ru/transactional/api/v1/email/send.json');
  assert.deepEqual(message.recipients, [{ email }]);
  assert.equal(message.track_links, 0);
  const link = new URL(message.body.plaintext.split('\n')[1]);
  assert.equal(link.origin, origin);
  assert.equal(link.pathname, '/recovery.html');
  assert.equal(link.search, '');
  const token = link.hash.slice(1);
  const record = db.prepare('SELECT token_hash, expires_at, requested_at FROM password_resets').get();
  assert.equal(record.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(record.expires_at - record.requested_at, 15 * 60);

  const newCredentials = { email, credential: 'cd'.repeat(32) };
  const resetBody = { ...newCredentials, token };
  assert.equal((await post(reset, { ...resetBody, email: otherEmail })).status, 400);
  db.exec('UPDATE password_resets SET expires_at = 0');
  assert.equal((await post(reset, resetBody)).status, 400);
  db.prepare('UPDATE password_resets SET expires_at = ?').run(record.expires_at);
  const results = await Promise.all([post(reset, resetBody), post(reset, resetBody)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.match(results.find(result => result.ok).headers.get('Set-Cookie'), /Max-Age=0/);
  for (const cookie of [oldSession, secondSession]) {
    assert.equal((await call('/api/account', { cookie })).status, 401);
  }
  assert.equal((await call('/api/account', { cookie: otherSession })).status, 200);
  assert.equal((await post(login, credentials)).status, 401);
  assert.equal((await post(login, newCredentials)).status, 200);
});

test('homework belongs to one student and completion persists across sessions', async t => {
  const { db, env, call, register } = setup(t);
  const first = await register();
  const cookie = first.headers.get('Set-Cookie').split(';')[0];
  const second = await register({ email: 'second@example.test' });
  const otherCookie = second.headers.get('Set-Cookie').split(';')[0];
  const studentId = db.prepare('SELECT id FROM users WHERE email = ?').get(credentials.email.trim()).id;
  assert.equal((await call('/api/account/study')).status, 401);
  const id = 'homework-1';
  const title = '<script>Title</script>';
  db.prepare(`INSERT INTO homework (id, user_id, title, instructions, resource_url, due_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, studentId, title, 'Read chapter 1.\nAnswer questions.', 'https://example.com/workbook', '2027-01-01', 100);
  const read = async cookie => (await (await call('/api/account/study', { cookie })).json()).homework;
  assert.equal((await read(otherCookie)).length, 0);
  assert.equal((await read(cookie))[0].completed_at, null);
  assert.equal((await read(cookie))[0].title, title);
  assert.equal((await call('/api/account/study?studentId=other', { cookie })).status, 200);
  const mark = (cookie, body, from) => call('/api/account/study', { method: 'PATCH', cookie, body, from });
  assert.equal((await mark(otherCookie, { homeworkId: id, completed: true, studentId })).status, 404);
  assert.equal((await mark(cookie, { homeworkId: id, completed: true }, 'https://evil.example')).status, 403);
  assert.equal((await mark(cookie, { homeworkId: id, completed: 'yes' })).status, 400);
  assert.equal((await mark(cookie, { homeworkId: id, completed: true })).status, 200);
  const completedAt = (await read(cookie))[0].completed_at;
  assert.ok(completedAt > 0);
  assert.equal((await mark(cookie, { homeworkId: id, completed: true })).status, 200);
  assert.equal((await read(cookie))[0].completed_at, completedAt);
  await call('/api/account/logout', { method: 'POST', cookie });
  const login = await call('/api/account/login', { method: 'POST', body: credentials });
  const newCookie = login.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await read(newCookie))[0].completed_at, completedAt);
  assert.equal((await mark(newCookie, { homeworkId: id, completed: false })).status, 200);
  assert.equal((await read(newCookie))[0].completed_at, null);
  db.exec('UPDATE sessions SET expires_at = 0');
  assert.equal((await call('/api/account/study', { cookie: newCookie })).status, 401);
});

test('students see their own lessons while all assigned lessons block public booking times', async t => {
  const { db, env, call, register } = setup(t);
  const registered = await register();
  const cookie = registered.headers.get('Set-Cookie').split(';')[0];
  await register({ email: 'second@example.test' });
  const users = db.prepare('SELECT id FROM users ORDER BY email').all();
  const date = addDays(localNow('Asia/Irkutsk').slice(0, 10), 2);
  const week = weekStart(date);
  const day = Math.round((Date.parse(date) - Date.parse(week)) / 86400000);
  const schedule = {
    repeat: false, timeZone: 'Asia/Irkutsk', template: [],
    weeks: { [week]: ['18:00', '19:00', '19:30', '20:00'].map(time => ({ day, time, status: 'free' })) },
  };
  db.prepare('INSERT INTO schedule (id, data, revision) VALUES (1, ?, 1)').run(JSON.stringify(schedule));
  const start = Date.parse(`${date}T19:00:00+08:00`) / 1000;
  const insert = db.prepare('INSERT INTO lessons (id, user_id, title, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)');
  insert.run('lesson-1', users[0].id, 'Английский', start, start + 3600);
  insert.run('lesson-2', users[1].id, 'Другой ученик', start + 3600, start + 7200);
  const personal = await (await call('/api/account/study?studentId=' + users[1].id, { cookie })).json();
  assert.equal(personal.lessons.length, 1);
  assert.equal(personal.lessons[0].id, 'lesson-1');
  assert.equal(personal.timeZone, 'Asia/Irkutsk');
  const readSlots = async () => (await (await call('/api/schedule?week=' + week)).json()).slots;
  assert.deepEqual((await readSlots()).map(slot => slot.status), ['free', 'taken', 'taken', 'taken']);
  Object.assign(env, { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat', BOOKING_LIMITER: { limit: async () => ({ success: true }) } });
  const booking = { name: 'Тест', contact: '@example', goal: 'Для работы', message: '', consent: 'on', slotDate: date, slotTime: '19:00' };
  assert.equal((await call('/api/booking', { method: 'POST', body: booking })).status, 409);
  db.prepare('UPDATE lessons SET cancelled_at = ? WHERE id = ?').run(100, 'lesson-1');
  assert.deepEqual((await readSlots()).map(slot => slot.status), ['free', 'free', 'free', 'taken']);
  const cancelled = await (await call('/api/account/study', { cookie })).json();
  assert.equal(cancelled.lessons[0].cancelled_at, 100);
});
