import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.mjs';

const origin = 'https://example.com';
const credentials = { email: ' learner@example.test ', password: 'test password 1' };

function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const env = {
    ASSETS: { fetch: async () => new Response('Account page') },
    AUTH_LIMITER: { limit: async () => ({ success: true }) },
    DB: {
      prepare: sql => ({
        bind: (...args) => ({
          first: async () => db.prepare(sql).get(...args) ?? null,
          run: () => ({ meta: db.prepare(sql).run(...args) }),
        }),
      }),
      batch: async statements => {
        db.exec('BEGIN');
        try {
          const results = statements.map(statement => statement.run());
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
  };
  function call(path, { method = 'GET', body, cookie, from = origin } = {}) {
    const headers = { Origin: from, 'CF-Connecting-IP': '192.0.2.1' };
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    return worker.fetch(new Request(origin + path, { method, headers, body: JSON.stringify(body) }), env);
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
  assert.match(savedPassword, /^[a-f0-9]{64}$/);
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
  assert.equal((await call('/api/account/login', { method: 'POST', body: { ...credentials, password: 'incorrect password' } })).status, 401);
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
