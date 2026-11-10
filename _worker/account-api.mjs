import { createHash, pbkdf2, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(pbkdf2);
const sessionSeconds = 30 * 24 * 60 * 60;
const routes = new Map([
  ['/api/account', ['GET', 'PATCH']],
  ['/api/account/register', ['POST']],
  ['/api/account/login', ['POST']],
  ['/api/account/logout', ['POST']],
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
  return /^[A-Za-z0-9_-]{43}$/.test(token ?? '') ? digest(token) : null;
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

async function readBody(request) {
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
      if (size > 8192) {
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

async function signIn(request, env, url, data, registering) {
  const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
  const name = registering ? cleanName(data?.name) : '';
  const password = data?.password;
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email) ||
      typeof password !== 'string' || password.length < 12 || password.length > 128 ||
      (registering && !name)) return json({ error: 'invalid' }, 400);

  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || !env.AUTH_LIMITER) return json({ error: 'unavailable' }, 503);
  const limits = await Promise.all([
    env.AUTH_LIMITER.limit({ key: `ip:${ip}` }),
    env.AUTH_LIMITER.limit({ key: `email:${digest(email)}` }),
  ]);
  if (limits.some(limit => !limit.success)) return json({ error: 'limit' }, 429);

  const db = env.DB;
  const user = registering ? { id: randomUUID(), email, name }
    : await db.prepare('SELECT id, email, name, password_salt, password_hash FROM users WHERE email = ?').bind(email).first();
  const salt = registering ? randomBytes(16).toString('hex') : user?.password_salt ?? '0'.repeat(32);
  const hash = await derive(password, Buffer.from(salt, 'hex'), 600_000, 32, 'sha256');
  if (!registering && (!user || !timingSafeEqual(hash, Buffer.from(user.password_hash, 'hex')))) {
    return json({ error: 'credentials' }, 401);
  }

  const token = randomBytes(32).toString('base64url');
  const timestamp = now();
  const statements = [db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(timestamp)];
  if (registering) {
    statements.push(db.prepare(`
      INSERT INTO users (id, email, name, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email) DO NOTHING
    `).bind(user.id, email, name, salt, hash.toString('hex')));
  }
  const oldHash = sessionHash(request);
  if (oldHash) {
    statements.push(db.prepare('DELETE FROM sessions WHERE token_hash = ? AND EXISTS (SELECT 1 FROM users WHERE id = ?)').bind(oldHash, user.id));
  }
  statements.push(db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at) SELECT ?, id, ? FROM users WHERE id = ?
  `).bind(digest(token), timestamp + sessionSeconds, user.id));
  const result = await db.batch(statements);
  if (result.at(-1).meta.changes !== 1) return json({ error: 'email_exists' }, 409);
  return json({ profile: publicProfile(user) }, registering ? 201 : 200, {
    'Set-Cookie': cookie(url, token, sessionSeconds),
  });
}

export async function accountApi(request, env, url) {
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
