import { scheduleApi } from './schedule-api.mjs';
import { secureResponse } from './security.mjs';
import { accountApi, accountUser } from './account-api.mjs';
import { learningApi } from './learning-api.mjs';
import { teacherApi } from './teacher-api.mjs';
import { teacherAuthApi } from './teacher-auth.mjs';
import { bookingApi, retryNotifications } from './booking-api.mjs';
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const accountPages = new Set(['/account', '/account/', '/account.html']);
const publicPaths = new Set(['/api/config', '/api/schedule', '/api/booking']);
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
    const teacherAuth = await teacherAuthApi(request, env, url);
    if (teacherAuth) return teacherAuth;
    const teacherResponse = await teacherApi(request, env, url);
    if (teacherResponse) return teacherResponse;
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
    const bookingResponse = await bookingApi(request, env, url);
    if (bookingResponse) return bookingResponse;
    if (url.pathname.startsWith('/api/')) return json({ ok: false }, 404);
    if (url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    return env.ASSETS.fetch(request);
  }
};
export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(retryNotifications(env)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let privatePage = false;
    try {
      privatePage = isAccountPage(url.pathname) || url.pathname.startsWith('/api/admin/') ||
        url.pathname === '/teacher.html' || url.pathname === '/teacher.js' || url.pathname.startsWith('/api/teacher/') || url.pathname === '/admin.html' || url.pathname === '/admin.js' || url.pathname === '/recovery.html';
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
