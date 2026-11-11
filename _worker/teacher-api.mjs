import { readBody } from './account-api.mjs';
import { teacherAccess } from './teacher-auth.mjs';
import { validDate } from './schedule.mjs';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const now = () => Math.floor(Date.now() / 1000);
const routes = new Map([
  ['/api/teacher/dashboard', ['GET']],
  ['/api/teacher/study', ['GET', 'POST', 'PATCH', 'DELETE']],
  ['/api/teacher/request', ['PATCH']],
]);

function text(value, max) {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value.trim() : null;
}

function link(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function lessonFields(data) {
  const title = text(data.title, 160);
  const meetingUrl = link(data.meetingUrl);
  if (!title || meetingUrl === null || !validDate(data.date) || typeof data.time !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time) || ![30, 60, 90].includes(data.duration)) return null;
  const start = Date.parse(`${data.date}T${data.time}:00+08:00`) / 1000;
  if (start <= now()) return null;
  return { title, meetingUrl, start, end: start + data.duration * 60 };
}

async function confirmRequest(env, data) {
  const db = env.DB;
  const request = await db.prepare('SELECT * FROM booking_requests WHERE id = ?').bind(data.id).first();
  if (!request) return json({ error: 'missing' }, 404);
  if (data.action === 'decline') {
    const result = await db.prepare("UPDATE booking_requests SET status = 'declined' WHERE id = ? AND status = 'pending'").bind(data.id).run();
    return result.meta.changes === 1 || request.status === 'declined' ? json({ ok: true }) : json({ error: 'conflict' }, 409);
  }
  if (data.action !== 'confirm') return json({ error: 'invalid' }, 400);
  const fields = lessonFields(data);
  if (!fields) return json({ error: 'invalid_lesson' }, 400);
  const studentId = request.user_id ?? data.studentId;
  if (typeof studentId !== 'string' || !await db.prepare('SELECT id FROM users WHERE id = ?').bind(studentId).first()) {
    return json({ error: 'student_missing' }, 400);
  }
  const id = 'request-' + request.id;
  const [, changed] = await db.batch([
    db.prepare(`INSERT INTO lessons (id, user_id, title, starts_at, ends_at, meeting_url)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM booking_requests WHERE id = ? AND status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM lessons WHERE cancelled_at IS NULL AND starts_at < ? AND ends_at > ?)
        AND NOT EXISTS (SELECT 1 FROM booking_requests WHERE status = 'pending' AND id <> ? AND starts_at < ? AND ends_at > ?)
      ON CONFLICT(id) DO NOTHING`)
      .bind(id, studentId, fields.title, fields.start, fields.end, fields.meetingUrl, request.id, fields.end, fields.start, request.id, fields.end, fields.start),
    db.prepare(`UPDATE booking_requests SET status = 'confirmed', lesson_id = ?, user_id = ?, starts_at = ?, ends_at = ?, duration = ?
      WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM lessons WHERE id = ?)`)
      .bind(id, studentId, fields.start, fields.end, data.duration, request.id, id),
  ]);
  if (changed.meta.changes === 1) return json({ ok: true });
  const previous = await db.prepare(`SELECT id FROM lessons WHERE id = ? AND user_id = ? AND title = ?
    AND starts_at = ? AND ends_at = ? AND meeting_url = ? AND cancelled_at IS NULL`)
    .bind(id, studentId, fields.title, fields.start, fields.end, fields.meetingUrl).first();
  return previous ? json({ ok: true }) : json({ error: 'conflict' }, 409);
}

export async function teacherApi(request, env, url) {
  const methods = routes.get(url.pathname);
  if (!methods) return null;
  if (!methods.includes(request.method)) return json({ error: 'method' }, 405);
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return json({ error: 'origin' }, 403);
  const denied = await teacherAccess(request, env);
  if (denied) return denied;
  const db = env.DB;
  if (url.pathname.endsWith('/dashboard')) {
    const [students, requests, lessons] = await db.batch([
      db.prepare('SELECT id, name, email FROM users ORDER BY name, email'),
      db.prepare("SELECT * FROM booking_requests WHERE status = 'pending' ORDER BY created_at"),
      db.prepare(`SELECT lessons.*, users.name, users.email FROM lessons JOIN users ON users.id = lessons.user_id
        WHERE cancelled_at IS NULL AND ends_at > ? ORDER BY starts_at`).bind(now()),
    ]);
    return json({ students: students.results, requests: requests.results, lessons: lessons.results });
  }
  if (request.method === 'GET') {
    const studentId = url.searchParams.get('studentId') ?? '';
    const student = await db.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(studentId).first();
    if (!student) return json({ error: 'missing' }, 404);
    const [lessons, homework] = await db.batch([
      db.prepare('SELECT * FROM lessons WHERE user_id = ? ORDER BY starts_at DESC').bind(studentId),
      db.prepare('SELECT * FROM homework WHERE user_id = ? ORDER BY created_at DESC, id').bind(studentId),
    ]);
    return json({ student, lessons: lessons.results, homework: homework.results });
  }
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'type' }, 415);
  const data = await readBody(request, 32768);
  if (!data || typeof data.id !== 'string' || data.id.length > 100) return json({ error: 'invalid' }, 400);
  if (url.pathname.endsWith('/request')) return confirmRequest(env, data);
  if (!['lesson', 'homework'].includes(data.kind) || typeof data.studentId !== 'string') return json({ error: 'invalid' }, 400);
  if (request.method === 'DELETE') {
    if (data.kind === 'homework') {
      await db.prepare('DELETE FROM homework WHERE id = ? AND user_id = ?').bind(data.id, data.studentId).run();
    } else {
      await db.batch([
        db.prepare('UPDATE lessons SET cancelled_at = COALESCE(cancelled_at, ?) WHERE id = ? AND user_id = ?').bind(now(), data.id, data.studentId),
        db.prepare(`UPDATE booking_requests SET status = 'cancelled' WHERE lesson_id = ? AND status = 'confirmed'
          AND EXISTS (SELECT 1 FROM lessons WHERE id = ? AND user_id = ? AND cancelled_at IS NOT NULL)`)
          .bind(data.id, data.id, data.studentId),
      ]);
    }
    return json({ ok: true });
  }
  if (!await db.prepare('SELECT id FROM users WHERE id = ?').bind(data.studentId).first()) return json({ error: 'student_missing' }, 404);
  if (data.kind === 'homework') {
    const title = text(data.title, 160);
    const instructions = text(data.instructions, 4000);
    const resource = link(data.resourceUrl);
    if (!title || instructions === null || resource === null || (data.dueDate !== '' && !validDate(data.dueDate))) return json({ error: 'invalid' }, 400);
    if (request.method === 'PATCH') {
      const changed = await db.prepare(`UPDATE homework SET title = ?, instructions = ?, resource_url = ?, due_date = ?
        WHERE id = ? AND user_id = ?`).bind(title, instructions, resource, data.dueDate, data.id, data.studentId).run();
      return changed.meta.changes === 1 ? json({ ok: true }) : json({ error: 'missing' }, 404);
    }
    await db.prepare(`INSERT INTO homework (id, user_id, title, instructions, resource_url, due_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(data.id, data.studentId, title, instructions, resource, data.dueDate, now()).run();
    const same = await db.prepare(`SELECT id FROM homework WHERE id = ? AND user_id = ? AND title = ?
      AND instructions = ? AND resource_url = ? AND due_date = ?`)
      .bind(data.id, data.studentId, title, instructions, resource, data.dueDate).first();
    return same ? json({ ok: true }, 201) : json({ error: 'conflict' }, 409);
  }
  const fields = lessonFields(data);
  if (!fields) return json({ error: 'invalid_lesson' }, 400);
  const noOverlap = `NOT EXISTS (SELECT 1 FROM lessons WHERE cancelled_at IS NULL AND id <> ? AND starts_at < ? AND ends_at > ?)
    AND NOT EXISTS (SELECT 1 FROM booking_requests WHERE status = 'pending' AND starts_at < ? AND ends_at > ?)`;
  const overlapArgs = [data.id, fields.end, fields.start, fields.end, fields.start];
  const statement = request.method === 'POST'
    ? db.prepare(`INSERT INTO lessons (id, user_id, title, starts_at, ends_at, meeting_url)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${noOverlap} ON CONFLICT(id) DO NOTHING`)
      .bind(data.id, data.studentId, fields.title, fields.start, fields.end, fields.meetingUrl, ...overlapArgs)
    : db.prepare(`UPDATE lessons SET title = ?, starts_at = ?, ends_at = ?, meeting_url = ?
      WHERE id = ? AND user_id = ? AND cancelled_at IS NULL AND ${noOverlap}`)
      .bind(fields.title, fields.start, fields.end, fields.meetingUrl, data.id, data.studentId, ...overlapArgs);
  await db.batch([
    statement,
    db.prepare(`UPDATE booking_requests SET starts_at = ?, ends_at = ?, duration = ? WHERE lesson_id = ? AND status = 'confirmed'
      AND EXISTS (SELECT 1 FROM lessons WHERE id = ? AND starts_at = ? AND ends_at = ? AND cancelled_at IS NULL)`)
      .bind(fields.start, fields.end, data.duration, data.id, data.id, fields.start, fields.end),
  ]);
  const same = await db.prepare(`SELECT id FROM lessons WHERE id = ? AND user_id = ? AND title = ?
    AND starts_at = ? AND ends_at = ? AND meeting_url = ? AND cancelled_at IS NULL`)
    .bind(data.id, data.studentId, fields.title, fields.start, fields.end, fields.meetingUrl).first();
  return same ? json({ ok: true }, request.method === 'POST' ? 201 : 200) : json({ error: 'conflict' }, 409);
}
