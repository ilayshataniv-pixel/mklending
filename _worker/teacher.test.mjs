import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import worker from './worker.mjs';
import { testDatabase } from './database-fixture.mjs';
import { localNow, addDays, weekStart } from './schedule.mjs';
import { retryNotifications } from './booking-api.mjs';

async function setup(t) {
  const { db, binding } = testDatabase(t);
  const env = {
    DB: binding, ACCOUNT_PEPPER: '71'.repeat(32), ADMIN_KEY: 'teacher-test-'.repeat(4),
    AUTH_LIMITER: { limit: async () => ({ success: true }) },
    ADMIN_LIMITER: { limit: async () => ({ success: true }) },
    BOOKING_LIMITER: { limit: async () => ({ success: true }) },
    TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat', PAGES_ORIGIN: 'https://pages.example',
    ASSETS: { fetch: async () => new Response('page') },
  };
  function call(path, { method = 'GET', body, cookie, origin = 'https://example.com' } = {}) {
    const headers = { Origin: origin, 'CF-Connecting-IP': '192.0.2.1' };
    if (body) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    return worker.fetch(new Request('https://example.com' + path, { method, headers, body: JSON.stringify(body) }), env);
  }
  const register = async email => {
    const response = await call('/api/account/register', { method: 'POST', body: { name: email, email, credential: 'ab'.repeat(32) } });
    assert.equal(response.status, 201);
    return response.headers.get('Set-Cookie').split(';')[0];
  };
  const studentCookie = await register('learner@example.test');
  const otherCookie = await register('other@example.test');
  const student = db.prepare('SELECT id FROM users WHERE email = ?').get('learner@example.test').id;
  const other = db.prepare('SELECT id FROM users WHERE email = ?').get('other@example.test').id;
  const date = addDays(localNow('Asia/Irkutsk').slice(0, 10), 3);
  const week = weekStart(date);
  const day = (Date.parse(date) - Date.parse(week)) / 86400000;
  const schedule = { repeat: false, timeZone: 'Asia/Irkutsk', template: [], weeks: { [week]: ['14:00','15:00','16:00','17:00','18:00'].map(time => ({ day, time, status: 'free' })) } };
  db.prepare('INSERT INTO schedule (id, data, revision) VALUES (1, ?, 1)').run(JSON.stringify(schedule));
  const login = () => call('/api/teacher/login', { method: 'POST', body: { key: env.ADMIN_KEY } });
  const teacherCookie = (await login()).headers.get('Set-Cookie').split(';')[0];
  const teacher = (path, method = 'GET', body) => call('/api/teacher/' + path, { method, body, cookie: teacherCookie });
  const booking = { name: 'Ignored name', contact: '@example', goal: 'Для работы', message: '', consent: 'on',
    fromCabinet: true, slotDate: date, slotTime: '14:00', duration: 90, lessonType: 'regular', requestId: randomUUID() };
  return { db, env, call, login, teacher, teacherCookie, studentCookie, otherCookie, student, other, date, week, booking };
}

test('teacher sessions are separate from student sessions, check origin, expire and revoke on key rotation', async t => {
  const { db, env, call, login, studentCookie, teacherCookie } = await setup(t);
  assert.equal((await call('/api/teacher/dashboard')).status, 401);
  assert.equal((await call('/api/teacher/dashboard', { cookie: studentCookie })).status, 401);
  assert.equal((await call('/api/teacher/login', { method: 'POST', origin: 'https://evil.example', body: { key: env.ADMIN_KEY } })).status, 403);
  assert.equal((await call('/api/teacher/login', { method: 'POST', body: { key: 'wrong' } })).status, 401);
  const session = await login();
  assert.match(session.headers.get('Set-Cookie'), /^__Host-maria_teacher=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
  assert.equal((await call('/api/admin/schedule', { cookie: teacherCookie })).status, 200);
  env.ADMIN_KEY = 'rotated-test-'.repeat(4);
  assert.equal((await call('/api/teacher/dashboard', { cookie: teacherCookie })).status, 401);
  const rotated = (await login()).headers.get('Set-Cookie').split(';')[0];
  db.exec('UPDATE teacher_sessions SET expires_at = 0');
  assert.equal((await call('/api/teacher/session', { cookie: rotated })).status, 401);
});

test('cabinet bookings reserve atomically, retry safely, notify once, and become lessons after teacher confirmation', async t => {
  const { db, call, teacher, studentCookie, otherCookie, student, other, date, week, booking } = await setup(t);
  const messages = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    messages.push(JSON.parse(options.body));
    assert.equal(db.prepare('SELECT count(*) AS total FROM booking_requests').get().total, 1);
    return Response.json({ ok: true });
  });
  const post = (body, cookie = studentCookie) => call('/api/booking', { method: 'POST', body, cookie });
  const competing = await Promise.all([post({ ...booking, user_id: other }), post({ ...booking, requestId: randomUUID() }, otherCookie)]);
  assert.deepEqual(competing.map(response => response.status).sort(), [201, 409]);
  assert.equal((await post(booking)).status, 200);
  assert.equal((await post({ ...booking, message: 'changed replay' })).status, 409);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].chat_id, 'test-chat');
  const own = await (await call('/api/account/study', { cookie: studentCookie })).json();
  const foreign = await (await call('/api/account/study', { cookie: otherCookie })).json();
  assert.equal(own.bookings.length, 1);
  assert.equal(foreign.bookings.length, 0);
  assert.equal(db.prepare('SELECT user_id FROM booking_requests').get().user_id, student);
  const slots = await (await call('/api/schedule?week=' + week)).json();
  assert.equal(slots.slots.find(slot => slot.time === '15:00').status, 'taken');
  const confirm = { id: booking.requestId, action: 'confirm', title: 'English lesson', date, time: '14:00', duration: 90, meetingUrl: 'https://example.com/meeting', studentId: other };
  assert.equal((await teacher('request', 'PATCH', confirm)).status, 200);
  assert.equal((await teacher('request', 'PATCH', confirm)).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS total FROM lessons').get().total, 1);
  assert.equal(db.prepare('SELECT user_id FROM lessons').get().user_id, student);
  assert.equal((await (await call('/api/account/study', { cookie: studentCookie })).json()).lessons.length, 1);
  assert.equal((await call('/api/account/booking', { method: 'PATCH', cookie: studentCookie, body: { id: booking.requestId } })).status, 409);
  const task = { id: randomUUID(), studentId: student, kind: 'homework', title: 'Read', instructions: 'Прочитай главу.\nОтветь на вопросы.', dueDate: date, resourceUrl: 'https://example.com/workbook' };
  assert.equal((await teacher('study', 'POST', task)).status, 201);
  assert.equal((await teacher('study', 'POST', task)).status, 201);
  assert.equal(db.prepare('SELECT count(*) AS total FROM homework').get().total, 1);
  assert.equal((await call('/api/account/study', { method: 'PATCH', cookie: studentCookie, body: { homeworkId: task.id, completed: true } })).status, 200);
  const view = await (await teacher('study?studentId=' + student)).json();
  assert.ok(view.homework[0].completed_at);
  assert.equal((await teacher('study', 'PATCH', { ...task, title: 'Edited homework' })).status, 200);
  assert.ok(db.prepare('SELECT completed_at FROM homework WHERE id = ?').get(task.id).completed_at);
  assert.equal((await teacher('study', 'DELETE', { id: 'request-' + booking.requestId, studentId: student, kind: 'lesson' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM booking_requests').get().status, 'cancelled');
});

test('stored bookings survive Telegram failure, retry delivery and allow only the owner to cancel pending requests', async t => {
  const { db, env, call, booking, studentCookie, otherCookie, week } = await setup(t);
  let sent = 0;
  t.mock.method(globalThis, 'fetch', async () => { sent++; return Response.json({ ok: sent > 1 }); });
  assert.equal((await call('/api/booking', { method: 'POST', cookie: studentCookie, body: booking })).status, 201);
  assert.equal(db.prepare('SELECT notified_at FROM booking_requests').get().notified_at, null);
  db.exec('UPDATE booking_requests SET notification_lease_until = 0');
  await retryNotifications(env);
  await retryNotifications(env);
  assert.equal(sent, 2);
  assert.ok(db.prepare('SELECT notified_at FROM booking_requests').get().notified_at);
  const cancel = cookie => call('/api/account/booking', { method: 'PATCH', cookie, body: { id: booking.requestId } });
  assert.equal((await cancel(otherCookie)).status, 409);
  assert.equal((await cancel(studentCookie)).status, 200);
  assert.equal((await cancel(studentCookie)).status, 200);
  const slots = await (await call('/api/schedule?week=' + week)).json();
  assert.equal(slots.slots.find(slot => slot.time === '14:00').status, 'free');
});

test('teacher cannot double-book lessons and homework accepts the full supported text size', async t => {
  const { db, teacher, student, other, date } = await setup(t);
  const lesson = { id: randomUUID(), kind: 'lesson', studentId: student, title: 'English', date, time: '17:00', duration: 60, meetingUrl: '' };
  const results = await Promise.all([teacher('study', 'POST', lesson), teacher('study', 'POST', { ...lesson, id: randomUUID(), studentId: other })]);
  assert.deepEqual(results.map(response => response.status).sort(), [201, 409]);
  assert.equal((await teacher('study', 'POST', lesson)).status, 201);
  assert.equal((await teacher('study', 'POST', { ...lesson, id: randomUUID(), time: '17:30' })).status, 409);
  const task = { id: randomUUID(), kind: 'homework', studentId: student, title: 'Задание', instructions: 'я'.repeat(4000), dueDate: '', resourceUrl: '' };
  assert.equal((await teacher('study', 'POST', task)).status, 201);
  assert.equal(db.prepare('SELECT length(instructions) AS size FROM homework').get().size, 4000);
  assert.equal((await teacher('study', 'POST', { ...task, id: randomUUID(), resourceUrl: 'javascript:alert(1)' })).status, 400);
});

test('public guest bookings still work and can be assigned to a registered student by the teacher', async t => {
  const { db, call, teacher, student, date, booking } = await setup(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  assert.equal((await call('/api/booking', { method: 'POST', body: booking })).status, 401);
  const guest = { ...booking, fromCabinet: undefined, slotTime: '16:00', duration: 60 };
  const sent = await call('/api/booking', { method: 'POST', body: guest, origin: 'https://pages.example' });
  assert.equal(sent.status, 201);
  assert.equal(sent.headers.get('Access-Control-Allow-Origin'), 'https://pages.example');
  assert.equal(db.prepare('SELECT user_id FROM booking_requests WHERE id = ?').get(guest.requestId).user_id, null);
  const confirm = { id: guest.requestId, action: 'confirm', title: 'Guest lesson', date, time: '16:00', duration: 60, meetingUrl: '' };
  assert.equal((await teacher('request', 'PATCH', confirm)).status, 400);
  assert.equal((await teacher('request', 'PATCH', { ...confirm, studentId: student })).status, 200);
  assert.equal(db.prepare('SELECT user_id FROM booking_requests WHERE id = ?').get(guest.requestId).user_id, student);
});
