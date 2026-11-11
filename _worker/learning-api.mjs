import { accountUser, readBody } from './account-api.mjs';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function learningApi(request, env, url) {
  if (url.pathname !== '/api/account/study') return null;
  if (!['GET', 'PATCH'].includes(request.method)) return json({ error: 'method' }, 405);
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return json({ error: 'origin' }, 403);
  if (!env.DB) return json({ error: 'unavailable' }, 503);
  const student = await accountUser(request, env);
  if (!student) return json({ error: 'unauthorized' }, 401);
  if (request.method === 'GET') {
    const [lessons, homework] = await env.DB.batch([
      env.DB.prepare(`SELECT id, title, starts_at, ends_at, meeting_url, cancelled_at
        FROM lessons WHERE user_id = ? ORDER BY starts_at`).bind(student.id),
      env.DB.prepare(`SELECT id, title, instructions, resource_url, due_date, created_at, completed_at
        FROM homework WHERE user_id = ? ORDER BY created_at DESC, id`).bind(student.id),
    ]);
    return json({ lessons: lessons.results, homework: homework.results, timeZone: 'Asia/Irkutsk' });
  }
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: 'type' }, 415);
  }
  const data = await readBody(request);
  if (typeof data?.homeworkId !== 'string' || typeof data?.completed !== 'boolean') return json({ error: 'invalid' }, 400);
  const result = await env.DB.prepare(`UPDATE homework SET completed_at =
    CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE NULL END WHERE id = ? AND user_id = ?`)
    .bind(data.completed ? 1 : 0, Math.floor(Date.now() / 1000), data.homeworkId, student.id).run();
  return result.meta.changes === 1 ? json({ ok: true }) : json({ error: 'homework_missing' }, 404);
}
