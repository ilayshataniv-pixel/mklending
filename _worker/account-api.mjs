import { createHash, createHmac, pbkdf2, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(pbkdf2);
const credentialVersion = 'v2:';
const sessionSeconds = 30 * 24 * 60 * 60;
const resetMinutes = 15;
const emailPattern = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const credentialPattern = /^[a-f0-9]{64}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const routes = new Map([
  ['/api/account', ['GET', 'PATCH']],
  ['/api/account/register', ['POST']],
  ['/api/account/login', ['POST']],
  ['/api/account/logout', ['POST']],
  ['/api/account/recovery', ['POST']],
  ['/api/account/reset', ['POST']],
]);
const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const digest = token => createHash('sha256').update(token).digest('hex');
const publicProfile = ({ name, email }) => ({ name, email });
const now = () => Math.floor(Date.now() / 1000);
const cookieName = url => url.protocol === 'https:' ? '__Host-maria_session' : 'maria_session';
const cookie = (url, token, maxAge) =>
  `${cookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === 'https:' ? '; Secure' : ''}`;

function sessionHash(request) {
  const prefix = cookieName(new URL(request.url)) + '=';
  const token = request.headers.get('Cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(prefix))?.slice(prefix.length);
  return tokenPattern.test(token ?? '') ? digest(token) : null;
}

export function accountUser(request, env) {
  const hash = sessionHash(request);
  if (!hash || !env.DB) return null;
  return env.DB.prepare(`
    SELECT users.id, users.name, users.email FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).bind(hash, now()).first();
}

export async function readBody(request, maxBytes = 8192) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(text + decoder.decode());
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name) ? name : '';
}

function cleanEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length <= 254 && emailPattern.test(email) ? email : '';
}

function passwordHash(pepper, email, salt, credential) {
  return createHmac('sha256', Buffer.from(pepper, 'hex'))
    .update(JSON.stringify([email, salt, credential])).digest();
}

async function signIn(request, env, url, data, registering) {
  const email = cleanEmail(data?.email);
  const name = registering ? cleanName(data?.name) : '';
  const credential = data?.credential;
  if (!email || typeof credential !== 'string' || !credentialPattern.test(credential) ||
      (registering && !name)) return json({ error: 'invalid' }, 400);

  const ip = request.headers.get('CF-Connecting-IP');
  const pepper = env.ACCOUNT_PEPPER;
  if (!ip || !env.AUTH_LIMITER || !credentialPattern.test(pepper ?? '')) {
    return json({ error: 'unavailable' }, 503);
  }
  const limits = await Promise.all([
    env.AUTH_LIMITER.limit({ key: `ip:${ip}` }),
    env.AUTH_LIMITER.limit({ key: `email:${digest(email)}` }),
  ]);
  if (limits.some(limit => !limit.success)) return json({ error: 'limit' }, 429);

  const db = env.DB;
  const user = registering ? { id: randomUUID(), email, name }
    : await db.prepare('SELECT id, email, name, password_salt, password_hash FROM users WHERE email = ?').bind(email).first();
  const salt = registering ? randomBytes(16).toString('hex') : user?.password_salt ?? '0'.repeat(32);
  const hash = passwordHash(pepper, email, salt, credential);
  const legacyHash = !registering && user && credentialPattern.test(user.password_hash);
  if (!registering) {
    if (legacyHash) {
      // Upgrade locally created accounts after verifying their original password.
      const password = data?.password;
      if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
        return json({ error: 'legacy_credentials' }, 409);
      }
      const previous = await derive(password, Buffer.from(salt, 'hex'), 600_000, 32, 'sha256');
      if (!timingSafeEqual(previous, Buffer.from(user.password_hash, 'hex'))) {
        return json({ error: 'credentials' }, 401);
      }
    } else {
      const stored = user?.password_hash;
      if (!/^v2:[a-f0-9]{64}$/.test(stored ?? '') ||
          !timingSafeEqual(hash, Buffer.from(stored.slice(credentialVersion.length), 'hex'))) {
        return json({ error: 'credentials' }, 401);
      }
    }
  }

  const token = randomBytes(32).toString('base64url');
  const timestamp = now();
  const statements = [db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(timestamp)];
  const storedHash = credentialVersion + hash.toString('hex');
  if (registering) {
    statements.push(db.prepare(`
      INSERT INTO users (id, email, name, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email) DO NOTHING
    `).bind(user.id, email, name, salt, storedHash));
  } else if (legacyHash) {
    statements.push(db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?')
      .bind(storedHash, user.id, user.password_hash));
  }
  const oldHash = sessionHash(request);
  if (oldHash) {
    statements.push(db.prepare(`
      DELETE FROM sessions WHERE token_hash = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)
    `).bind(oldHash, user.id, storedHash));
  }
  statements.push(db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    SELECT ?, id, ? FROM users WHERE id = ? AND password_hash = ?
  `).bind(digest(token), timestamp + sessionSeconds, user.id, storedHash));
  const result = await db.batch(statements);
  if (result.at(-1).meta.changes !== 1) {
    return registering ? json({ error: 'email_exists' }, 409) : json({ error: 'credentials' }, 401);
  }
  return json({ profile: publicProfile(user) }, registering ? 201 : 200, {
    'Set-Cookie': cookie(url, token, sessionSeconds),
  });
}

async function sendResetLink(env, email) {
  const db = env.DB;
  const timestamp = now();
  const token = randomBytes(32).toString('base64url');
  const [, issued] = await db.batch([
    db.prepare('DELETE FROM password_resets WHERE expires_at <= ?').bind(timestamp),
    db.prepare(`
      INSERT INTO password_resets (user_id, token_hash, expires_at, requested_at)
      SELECT id, ?, ?, ? FROM users WHERE email = ?
      ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash,
        expires_at = excluded.expires_at, requested_at = excluded.requested_at
      WHERE password_resets.requested_at <= excluded.requested_at - 60
    `).bind(digest(token), timestamp + resetMinutes * 60, timestamp, email),
  ]);
  if (issued.meta.changes !== 1) return;

  const link = new URL('/recovery.html', env.RESET_ORIGIN);
  link.hash = token;
  const response = await fetch('https://goapi.unisender.ru/ru/transactional/api/v1/email/send.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': env.RESET_MAIL_API_KEY },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ message: {
      recipients: [{ email }],
      from_email: env.RESET_FROM_EMAIL,
      from_name: 'Мария / English',
      subject: 'Сброс пароля · Мария / English',
      body: { plaintext: [
        'Чтобы задать новый пароль, откройте ссылку:', link.href, '',
        `Ссылка действует ${resetMinutes} минут и сработает один раз.`,
        'Если вы не запрашивали сброс пароля, просто проигнорируйте письмо.',
      ].join('\n') },
      track_links: 0,
      track_read: 0,
    } }),
  });
  const result = await response.json();
  if (!response.ok || result.status !== 'success' || !result.emails?.includes(email)) {
    throw new Error('Mail was not accepted');
  }
}

async function recoverPassword(request, env, url, data, ctx) {
  const email = cleanEmail(data?.email);
  if (!email) return json({ error: 'invalid_email' }, 400);
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || !env.AUTH_LIMITER || !credentialPattern.test(env.ACCOUNT_PEPPER ?? '')) {
    return json({ error: 'unavailable' }, 503);
  }

  if (url.pathname === '/api/account/recovery') {
    if (url.origin !== env.RESET_ORIGIN || !env.RESET_MAIL_API_KEY || !cleanEmail(env.RESET_FROM_EMAIL)) {
      return json({ error: 'recovery_unavailable' }, 503);
    }
    if (!(await env.AUTH_LIMITER.limit({ key: `recovery:ip:${ip}` })).success) {
      return json({ error: 'limit' }, 429);
    }
    const delivery = sendResetLink(env, email).catch(() => console.warn('Password recovery delivery failed'));
    if (ctx) ctx.waitUntil(delivery);
    else await delivery;
    return json({ ok: true }, 202);
  }

  const { token, credential } = data;
  if (typeof token !== 'string' || !tokenPattern.test(token) ||
      typeof credential !== 'string' || !credentialPattern.test(credential)) {
    return json({ error: 'invalid_reset' }, 400);
  }
  if (!(await env.AUTH_LIMITER.limit({ key: `reset:ip:${ip}` })).success) {
    return json({ error: 'limit' }, 429);
  }
  const salt = randomBytes(16).toString('hex');
  const hash = credentialVersion + passwordHash(env.ACCOUNT_PEPPER, email, salt, credential).toString('hex');
  const db = env.DB;
  const match = `SELECT password_resets.user_id FROM password_resets
    JOIN users ON users.id = password_resets.user_id
    WHERE password_resets.token_hash = ? AND password_resets.expires_at > ? AND users.email = ?`;
  const criteria = [digest(token), now(), email];
  // Each statement uses the same reset record, which is consumed last in the transaction.
  const [changed] = await db.batch([
    db.prepare(`UPDATE users SET password_salt = ?, password_hash = ? WHERE id = (${match})`).bind(salt, hash, ...criteria),
    db.prepare(`DELETE FROM sessions WHERE user_id = (${match})`).bind(...criteria),
    db.prepare(`DELETE FROM password_resets WHERE user_id = (${match})`).bind(...criteria),
  ]);
  return changed.meta.changes === 1
    ? json({ ok: true }, 200, { 'Set-Cookie': cookie(url, '', 0) })
    : json({ error: 'invalid_reset' }, 400);
}

export async function accountApi(request, env, url, ctx) {
  const methods = routes.get(url.pathname);
  if (!methods) return null;
  if (!methods.includes(request.method)) return json({ error: 'method' }, 405, { Allow: methods.join(', ') });
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return json({ error: 'origin' }, 403);
  if (!env.DB) return json({ error: 'unavailable' }, 503);

  if (url.pathname === '/api/account/logout') {
    const hash = sessionHash(request);
    if (hash) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(url, '', 0) });
  }
  if (request.method === 'GET') {
    const user = await accountUser(request, env);
    return user ? json({ profile: publicProfile(user) }) : json({ error: 'unauthorized' }, 401);
  }
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: 'type' }, 415);
  }
  const data = await readBody(request);
  if (url.pathname === '/api/account/recovery' || url.pathname === '/api/account/reset') {
    return recoverPassword(request, env, url, data, ctx);
  }
  if (request.method === 'POST') return signIn(request, env, url, data, url.pathname.endsWith('/register'));

  const hash = sessionHash(request);
  if (!hash) return json({ error: 'unauthorized' }, 401);
  const name = cleanName(data?.name);
  if (!name) return json({ error: 'invalid_name' }, 400);
  const profile = await env.DB.prepare(`
    UPDATE users SET name = ? WHERE id = (
      SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?
    ) RETURNING name, email
  `).bind(name, hash, now()).first();
  return profile ? json({ profile }) : json({ error: 'unauthorized' }, 401);
}
