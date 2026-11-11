import { scheduleApi } from './schedule-api.mjs';
import { readSchedule, publicWeek, weekStart, validDate, localNow, addDays, lessonAvailability } from './schedule.mjs';
import { secureResponse } from './security.mjs';
import { accountApi, accountUser } from './account-api.mjs';
import { learningApi } from './learning-api.mjs';
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const accountPages = new Set(['/account', '/account/', '/account.html']);
const publicPaths = new Set(['/api/config', '/api/schedule', '/api/booking']);
const lessonTypes = new Map([['regular', 'Обычное занятие'], ['trial', 'Пробный урок']]);
const bookingDateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const escapeTelegramHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const isAccountPage = pathname => accountPages.has(decodeURI(pathname).replace(/\/{2,}/g, '/'));
const isPagesRequest = (request, env) => Boolean(env.PAGES_ORIGIN && request.headers.get('Origin') === env.PAGES_ORIGIN);
const handler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (isAccountPage(url.pathname)) {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
      if (!await accountUser(request, env)) return new Response(null, { status: 303, headers: { Location: '/auth.html' } });
      if (url.pathname !== '/account.html') return new Response(null, { status: 303, headers: { Location: '/account.html' } });
      return env.ASSETS.fetch(request);
    }
    const accountResponse = await accountApi(request, env, url, ctx);
    if (accountResponse) return accountResponse;
    const learningResponse = await learningApi(request, env, url);
    if (learningResponse) return learningResponse;
    const scheduleResponse = await scheduleApi(request, env);
    if (scheduleResponse) return scheduleResponse;
    const enabled = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && env.BOOKING_LIMITER);
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json({
        bookingEnabled: enabled,
        recoveryEnabled: Boolean(env.RESET_ORIGIN === url.origin && env.RESET_MAIL_API_KEY && env.RESET_FROM_EMAIL && env.ACCOUNT_PEPPER),
        prices: { '60': env.PRICE_60 || '', '90': env.PRICE_90 || '', trial: env.PRICE_TRIAL || '' },
      });
    }
    if (url.pathname === '/api/booking') {
      if (request.method !== 'POST') return json({ ok: false }, 405);
      if (request.headers.get('Origin') !== url.origin && !isPagesRequest(request, env)) return json({ ok: false }, 403);
      if (!enabled) return json({ ok: false }, 503);
      if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json({ ok: false }, 415);
      const ip = request.headers.get('CF-Connecting-IP');
      if (!ip) return json({ ok: false }, 503);
      const limit = await env.BOOKING_LIMITER.limit({ key: ip });
      if (!limit.success) return json({ ok: false }, 429);
      // Bound the streamed body as Content-Length can be missing or inaccurate.
      const reader = request.body?.getReader();
      if (!reader) return json({ ok: false }, 400);
      let bytes = 0; const chunks = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8192) { await reader.cancel(); return json({ ok: false }, 413); }
        chunks.push(value);
      }
      let data;
      try {
        const body = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        data = JSON.parse(new TextDecoder().decode(body));
      } catch { return json({ ok: false }, 400); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ ok: false }, 400);
      if (data.website) return json({ ok: true });
      const fields = { name: 80, contact: 120, goal: 100, message: 1000 };
      for (const [key, max] of Object.entries(fields)) {
        if (typeof data[key] !== 'string' || data[key].length > max) return json({ ok: false }, 400);
      }
      if (!data.name.trim() || !data.contact.trim() || data.consent !== 'on') return json({ ok: false }, 400);
      if (['name', 'contact', 'goal'].some(field => /[\u0000-\u001f\u007f]/.test(data[field]))) return json({ ok: false }, 400);
      if (!['Для жизни и общения', 'Для работы', 'Подготовка к экзамену', 'Хочу начать с основ', 'Пока не знаю — обсудим'].includes(data.goal)) return json({ ok: false }, 400);
      const lessonType = lessonTypes.get(data.lessonType);
      if (data.lessonType !== undefined && !lessonType) return json({ ok: false }, 400);
      let selectedSlot = 'Согласовать с учеником';
      if (data.slotDate || data.slotTime) {
        if (!validDate(data.slotDate) || typeof data.slotTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.slotTime)) return json({ ok: false }, 400);
        try {
          const saved = await readSchedule(env);
          if (!saved) return json({ ok: false }, 503);
          const firstWeek = weekStart(localNow(saved.data.timeZone).slice(0, 10));
          if (weekStart(data.slotDate) < firstWeek || weekStart(data.slotDate) > addDays(firstWeek, 56)) return json({ ok: false }, 409);
          const week = await lessonAvailability(env, publicWeek(saved.data, weekStart(data.slotDate)));
          if (!week.slots.some(s => s.date === data.slotDate && s.time === data.slotTime && s.status === 'free')) return json({ ok: false }, 409);
          const date = bookingDateFormat.format(new Date(`${data.slotDate}T00:00:00Z`));
          const zone = week.timeZone === 'Asia/Irkutsk' ? 'Иркутск' : week.timeZone;
          selectedSlot = `${date} в ${data.slotTime} · ${zone}`;
        } catch { return json({ ok: false }, 503); }
      }
      const comment = data.message.trim();
      const text = [
        '✨ <b>Новая заявка на занятие</b>',
        '',
        `🗓 <b>Время</b> · ${escapeTelegramHtml(selectedSlot)}`,
        ...(lessonType ? [`📚 <b>Формат</b> · ${lessonType}`] : []),
        `👤 <b>Имя</b> · ${escapeTelegramHtml(data.name.trim())}`,
        `📩 <b>Контакт</b> · ${escapeTelegramHtml(data.contact.trim())}`,
        `🎯 <b>Цель</b> · ${escapeTelegramHtml(data.goal)}`,
        '',
        ...(comment ? ['💬 <b>Комментарий</b>', `<blockquote>${escapeTelegramHtml(comment)}</blockquote>`, ''] : []),
        '⏳ <i>Ожидает подтверждения</i>',
      ].join('\n');
      try {
        const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }), signal: AbortSignal.timeout(10000)
        });
        const result = await response.json();
        if (!response.ok || result.ok !== true) return json({ ok: false }, 502);
        return json({ ok: true });
      } catch { return json({ ok: false }, 502); }
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false }, 404);
    if (url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    return env.ASSETS.fetch(request);
  }
};
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let privatePage = false;
    try {
      privatePage = isAccountPage(url.pathname) || url.pathname.startsWith('/api/admin/') ||
        url.pathname === '/admin.html' || url.pathname === '/admin.js' || url.pathname === '/recovery.html';
    } catch {
      return secureResponse(json({ ok: false }, 400));
    }
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      url.protocol = 'https:';
      return secureResponse(new Response(null, { status: 308, headers: { Location: url.href } }), privatePage);
    }
    const fromPages = publicPaths.has(url.pathname) && isPagesRequest(request, env);
    let response;
    try {
      if (fromPages && url.pathname === '/api/booking' && request.method === 'OPTIONS' &&
          request.headers.get('Access-Control-Request-Method') === 'POST') {
        response = new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        } });
      } else {
        response = await handler.fetch(request, env, ctx);
      }
    } catch {
      response = json({ ok: false }, 503);
    }
    const secured = secureResponse(response, privatePage);
    if (publicPaths.has(url.pathname)) secured.headers.append('Vary', 'Origin');
    if (fromPages) secured.headers.set('Access-Control-Allow-Origin', env.PAGES_ORIGIN);
    return secured;
  }
};
