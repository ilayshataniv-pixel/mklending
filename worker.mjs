const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const enabled = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && env.BOOKING_LIMITER);
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json({ bookingEnabled: enabled, telegramUsername: env.TELEGRAM_USERNAME || '', prices: { '60': env.PRICE_60 || '', '90': env.PRICE_90 || '' } });
    }
    if (url.pathname === '/api/booking') {
      if (request.method !== 'POST') return json({ ok: false }, 405);
      if (request.headers.get('Origin') !== url.origin) return json({ ok: false }, 403);
      if (!enabled) return json({ ok: false }, 503);
      if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ ok: false }, 415);
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
      const text = `Новая заявка с сайта\nИмя: ${data.name.trim()}\nTelegram: ${data.contact.trim()}\nЦель: ${data.goal}\nКомментарий: ${data.message || '—'}`;
      try {
        const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }), signal: AbortSignal.timeout(10000)
        });
        const result = await response.json();
        if (!response.ok || result.ok !== true) return json({ ok: false }, 502);
        return json({ ok: true });
      } catch { return json({ ok: false }, 502); }
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false }, 404);
    return env.ASSETS.fetch(request);
  }
};
