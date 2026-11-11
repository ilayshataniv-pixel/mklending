import { createHash, randomUUID } from 'node:crypto';
import { accountUser } from './account-api.mjs';
import { readSchedule, publicWeek, weekStart, validDate, localNow, addDays, lessonAvailability, slotEpoch } from './schedule.mjs';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Irkutsk' });
const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Irkutsk' });
const lessonTypes = new Map([['regular', 'Обычное занятие'], ['trial', 'Пробный урок']]);

async function sendMessage(env, booking) {
  const selected = booking.starts_at === null ? 'Согласовать с учеником'
    : `${dateFormat.format(new Date(booking.starts_at * 1000))} в ${timeFormat.format(new Date(booking.starts_at * 1000))} · Иркутск`;
  const text = [
    '✨ <b>Новая заявка на занятие</b>', '',
    `🗓 <b>Время</b> · ${escapeHtml(selected)}`,
    `📚 <b>Формат</b> · ${lessonTypes.get(booking.lesson_type)}`,
    `⏱ <b>Длительность</b> · ${booking.duration} мин`,
    `👤 <b>Имя</b> · ${escapeHtml(booking.name)}`,
    `📩 <b>Контакт</b> · ${escapeHtml(booking.contact)}`,
    `🎯 <b>Цель</b> · ${escapeHtml(booking.goal)}`, '',
    ...(booking.message ? ['💬 <b>Комментарий</b>', `<blockquote>${escapeHtml(booking.message)}</blockquote>`, ''] : []),
    '⏳ <i>Ожидает подтверждения</i>',
    ...(booking.id ? [`<code>${booking.id}</code>`] : []),
  ].join('\n');
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok || (await response.json()).ok !== true) throw new Error('Notification failed');
}

export async function notifyBooking(env, booking) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const lease = timestamp + 30;
  const claimed = await env.DB.prepare(`UPDATE booking_requests SET notification_lease_until = ?
    WHERE id = ? AND status = 'pending' AND notified_at IS NULL AND notification_lease_until <= ?`).bind(lease, booking.id, timestamp).run();
  if (claimed.meta.changes !== 1) return;
  try {
    await sendMessage(env, booking);
    await env.DB.prepare('UPDATE booking_requests SET notified_at = ? WHERE id = ? AND notification_lease_until = ?')
      .bind(Math.floor(Date.now() / 1000), booking.id, lease).run();
  } catch { console.warn('Booking notification will be retried'); }
}

export async function retryNotifications(env) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const { results } = await env.DB.prepare(`SELECT * FROM booking_requests
    WHERE status = 'pending' AND notified_at IS NULL AND notification_lease_until <= ? ORDER BY created_at LIMIT 20`)
    .bind(Math.floor(Date.now() / 1000)).all();
  await Promise.allSettled(results.map(booking => notifyBooking(env, booking)));
}

export async function bookingApi(request, env, url) {
  if (url.pathname !== '/api/booking') return null;
  if (request.method !== 'POST') return json({ ok: false }, 405);
  if (request.headers.get('Origin') !== url.origin && !(env.PAGES_ORIGIN && request.headers.get('Origin') === env.PAGES_ORIGIN)) return json({ ok: false }, 403);
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.BOOKING_LIMITER) return json({ ok: false }, 503);
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json({ ok: false }, 415);
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return json({ ok: false }, 503);
  if (!(await env.BOOKING_LIMITER.limit({ key: ip })).success) return json({ ok: false }, 429);
  const reader = request.body?.getReader();
  if (!reader) return json({ ok: false }, 400);
  let size = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); return json({ ok: false }, 413); }
    chunks.push(value);
  }
  let data;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return json({ ok: false }, 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ ok: false }, 400);
  if (data.website) return json({ ok: true });
  const student = request.headers.get('Origin') === url.origin ? await accountUser(request, env) : null;
  if (data.fromCabinet && !student) return json({ ok: false, error: 'unauthorized' }, 401);
  if (student) data.name = student.name;
  for (const [key, max] of Object.entries({ name: 80, contact: 120, goal: 100, message: 1000 })) {
    if (typeof data[key] !== 'string' || data[key].length > max) return json({ ok: false }, 400);
    data[key] = data[key].trim();
  }
  if (!data.name || !data.contact || data.consent !== 'on') return json({ ok: false }, 400);
  if (['name', 'contact', 'goal'].some(field => /[\u0000-\u001f\u007f]/.test(data[field]))) return json({ ok: false }, 400);
  if (!['Для жизни и общения', 'Для работы', 'Подготовка к экзамену', 'Хочу начать с основ', 'Пока не знаю — обсудим'].includes(data.goal)) return json({ ok: false }, 400);
  const type = data.lessonType ?? 'regular';
  const duration = Number(data.duration ?? (type === 'trial' ? 30 : 60));
  if (!lessonTypes.has(type) || (type === 'trial' ? duration !== 30 : ![60, 90].includes(duration))) return json({ ok: false }, 400);
  if (data.requestId !== undefined && (typeof data.requestId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.requestId))) return json({ ok: false }, 400);
  const id = data.requestId ?? randomUUID();
  // Keep a stable payload fingerprint so a timed-out submission can be retried safely.
  const payloadHash = createHash('sha256').update(JSON.stringify([student?.id ?? null, data.name, data.contact, data.goal, data.message, type, duration, data.slotDate ?? '', data.slotTime ?? ''])).digest('hex');
  if (env.DB) {
    const previous = await env.DB.prepare('SELECT * FROM booking_requests WHERE id = ?').bind(id).first();
    if (previous) {
      if (previous.payload_hash !== payloadHash) return json({ ok: false }, 409);
      await notifyBooking(env, previous);
      return json({ ok: true, id });
    }
  }
  let start = null;
  let revision = null;
  if (data.slotDate || data.slotTime) {
    if (!validDate(data.slotDate) || typeof data.slotTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.slotTime)) return json({ ok: false }, 400);
    const saved = await readSchedule(env);
    if (!saved) return json({ ok: false }, 503);
    const firstWeek = weekStart(localNow(saved.data.timeZone).slice(0, 10));
    if (weekStart(data.slotDate) < firstWeek || weekStart(data.slotDate) > addDays(firstWeek, 56)) return json({ ok: false }, 409);
    const week = await lessonAvailability(env, publicWeek(saved.data, weekStart(data.slotDate)));
    if (!week.slots.some(slot => slot.date === data.slotDate && slot.time === data.slotTime && slot.status === 'free')) return json({ ok: false }, 409);
    start = slotEpoch(data.slotDate, data.slotTime, week.timeZone);
    if (!Number.isFinite(start)) return json({ ok: false }, 400);
    revision = saved.revision;
  }
  const booking = { id, user_id: student?.id ?? null, name: data.name, contact: data.contact, goal: data.goal,
    message: data.message, lesson_type: type, duration, starts_at: start, ends_at: start === null ? null : start + duration * 60 };
  if (!env.DB) {
    try { await sendMessage(env, booking); return json({ ok: true }); }
    catch { return json({ ok: false }, 502); }
  }
  const result = await env.DB.prepare(`INSERT INTO booking_requests
    (id, user_id, name, contact, goal, message, lesson_type, duration, payload_hash, starts_at, ends_at, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM lessons WHERE cancelled_at IS NULL AND starts_at < ? AND ends_at > ?)
      AND NOT EXISTS (SELECT 1 FROM booking_requests WHERE status = 'pending' AND starts_at < ? AND ends_at > ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM schedule WHERE id = 1 AND revision = ?))
    ON CONFLICT(id) DO NOTHING`).bind(id, booking.user_id, booking.name, booking.contact, booking.goal, booking.message,
      type, duration, payloadHash, start, booking.ends_at, Math.floor(Date.now() / 1000),
      booking.ends_at, start, booking.ends_at, start, revision, revision).run();
  if (result.meta.changes !== 1) {
    const previous = await env.DB.prepare('SELECT * FROM booking_requests WHERE id = ?').bind(id).first();
    if (!previous || previous.payload_hash !== payloadHash) return json({ ok: false }, 409);
  }
  await notifyBooking(env, booking);
  return json({ ok: true, id }, 201);
}
