import { readSchedule, publicWeek, localNow, weekStart, validDate, addDays, validateSchedule } from './schedule.mjs';
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
async function authorized(request, env) {
  if (typeof env.ADMIN_KEY !== 'string' || env.ADMIN_KEY.length < 32) return false;
  const supplied = request.headers.get('Authorization') || '';
  if (supplied.length > 300) return false;
  const digest = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const a = await digest(supplied), b = await digest(`Bearer ${env.ADMIN_KEY}`);
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export async function scheduleApi(request, env) {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/api/schedule') {
      if (request.method !== 'GET') return json({ error: 'method' }, 405);
      const saved = await readSchedule(env);
      if (!saved) return json({ error: 'not_configured' }, 503);
      const today = localNow(saved.data.timeZone).slice(0, 10);
      const week = url.searchParams.get('week') || weekStart(today);
      if (!validDate(week) || weekStart(week) !== week || week < weekStart(today) || week > addDays(weekStart(today), 56)) return json({ error: 'week' }, 400);
      return json(publicWeek(saved.data, week));
    }
    if (url.pathname !== '/api/admin/schedule') return null;
    if (!env.DB || !env.ADMIN_LIMITER) return json({ error: 'not_configured' }, 503);
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip || !(await env.ADMIN_LIMITER.limit({ key: ip })).success) return json({ error: 'limit' }, 429);
    if (!await authorized(request, env)) return json({ error: 'unauthorized' }, 401);
    if (request.method === 'GET') return json(await readSchedule(env) || { data: { repeat: false, timeZone: 'Asia/Irkutsk', template: [], weeks: {} }, revision: 0 });
    if (request.method !== 'PUT') return json({ error: 'method' }, 405);
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin' }, 403);
    if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'type' }, 415);
    const reader = request.body?.getReader(); if (!reader) return json({ error: 'body' }, 400);
    const chunks = []; let size = 0;
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 500000) { await reader.cancel(); return json({ error: 'size' }, 413); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: 'json' }, 400); }
    if (!body || !Number.isInteger(body.revision) || body.revision < 0 || !validateSchedule(body.data) || body.data.repeat || body.data.template.length) return json({ error: 'invalid' }, 400);
    const payload = JSON.stringify(body.data);
    const result = body.revision === 0
      ? await env.DB.prepare('INSERT OR IGNORE INTO schedule (id, data, revision) VALUES (1, ?, 1)').bind(payload).run()
      : await env.DB.prepare('UPDATE schedule SET data = ?, revision = revision + 1 WHERE id = 1 AND revision = ?').bind(payload, body.revision).run();
    if (result.meta.changes !== 1) return json({ error: 'conflict' }, 409);
    return json({ ok: true, revision: body.revision + 1 });
  } catch { return json({ error: 'unavailable' }, 503); }
}
