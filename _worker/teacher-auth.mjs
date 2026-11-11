import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readBody } from './account-api.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const name = url => url.protocol === 'https:' ? '__Host-maria_teacher' : 'maria_teacher';
const cookie = (url, token, age) => `${name(url)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}`;
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

function sessionHash(request) {
  const prefix = name(new URL(request.url)) + '=';
  const token = request.headers.get('Cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
  return /^[\w-]{43}$/.test(token ?? '') ? digest(token) : null;
}

export function validTeacherKey(supplied, env) {
  if (typeof env.ADMIN_KEY !== 'string' || env.ADMIN_KEY.length < 32 || typeof supplied !== 'string' || supplied.length > 300) return false;
  return timingSafeEqual(Buffer.from(digest(supplied), 'hex'), Buffer.from(digest(env.ADMIN_KEY), 'hex'));
}

export async function teacherSession(request, env) {
  const hash = sessionHash(request);
  if (!hash || !env.DB || typeof env.ADMIN_KEY !== 'string' || env.ADMIN_KEY.length < 32) return false;
  return Boolean(await env.DB.prepare('SELECT token_hash FROM teacher_sessions WHERE token_hash = ? AND key_hash = ? AND expires_at > ?')
    .bind(hash, digest(env.ADMIN_KEY), now()).first());
}

export async function teacherAccess(request, env) {
  if (!env.DB || !env.ADMIN_LIMITER) return json({ error: 'unavailable' }, 503);
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || !(await env.ADMIN_LIMITER.limit({ key: `teacher:${ip}` })).success) return json({ error: 'limit' }, 429);
  const bearer = request.headers.get('Authorization');
  if (bearer?.startsWith('Bearer ') && validTeacherKey(bearer.slice(7), env)) return null;
  return await teacherSession(request, env) ? null : json({ error: 'unauthorized' }, 401);
}

export async function teacherAuthApi(request, env, url) {
  if (!['/api/teacher/session', '/api/teacher/login', '/api/teacher/logout'].includes(url.pathname)) return null;
  const method = url.pathname.endsWith('/session') ? 'GET' : 'POST';
  if (request.method !== method) return json({ error: 'method' }, 405);
  if (method !== 'GET' && request.headers.get('Origin') !== url.origin) return json({ error: 'origin' }, 403);
  if (!env.DB) return json({ error: 'unavailable' }, 503);
  if (url.pathname.endsWith('/session')) return await teacherSession(request, env) ? json({ ok: true }) : json({ error: 'unauthorized' }, 401);
  if (url.pathname.endsWith('/logout')) {
    const hash = sessionHash(request);
    if (hash) await env.DB.prepare('DELETE FROM teacher_sessions WHERE token_hash = ?').bind(hash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(url, '', 0) });
  }
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || !env.ADMIN_LIMITER) return json({ error: 'unavailable' }, 503);
  if (!(await env.ADMIN_LIMITER.limit({ key: `teacher-login:${ip}` })).success) return json({ error: 'limit' }, 429);
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'type' }, 415);
  const data = await readBody(request);
  if (!validTeacherKey(data?.key, env)) return json({ error: 'unauthorized' }, 401);
  const token = randomBytes(32).toString('base64url');
  const age = 12 * 60 * 60;
  const statements = [env.DB.prepare('DELETE FROM teacher_sessions WHERE expires_at <= ?').bind(now())];
  const previous = sessionHash(request);
  if (previous) statements.push(env.DB.prepare('DELETE FROM teacher_sessions WHERE token_hash = ?').bind(previous));
  statements.push(env.DB.prepare('INSERT INTO teacher_sessions (token_hash, key_hash, expires_at) VALUES (?, ?, ?)').bind(digest(token), digest(env.ADMIN_KEY), now() + age));
  await env.DB.batch(statements);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(url, token, age) });
}
