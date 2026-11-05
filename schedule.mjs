export const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
export function weekStart(value) {
  if (!validDate(value)) throw new Error('Invalid date');
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
export function addDays(value, count) {
  const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
export function localNow(timeZone, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function validateSchedule(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.template) || !data.weeks || typeof data.weeks !== 'object' || Array.isArray(data.weeks)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: data.timeZone }).format(); } catch { return false; }
  if (typeof data.timeZone !== 'string' || typeof data.repeat !== 'boolean') return false;
  const check = slots => Array.isArray(slots) && slots.length <= 140 && slots.every(s => s && Number.isInteger(s.day) && s.day >= 0 && s.day < 7 && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) && ['free', 'taken'].includes(s.status)) && new Set(slots.map(s => `${s.day}/${s.time}`)).size === slots.length;
  if (!check(data.template) || Object.keys(data.weeks).length > 60) return false;
  return Object.entries(data.weeks).every(([date, slots]) => validDate(date) && weekStart(date) === date && check(slots));
}
export function publicWeek(data, week, now = new Date()) {
  const current = localNow(data.timeZone, now);
  const slots = Object.hasOwn(data.weeks, week) ? data.weeks[week] : data.repeat ? data.template : [];
  return { week, timeZone: data.timeZone, slots: slots.map(s => ({ ...s, date: addDays(week, s.day), status: `${addDays(week, s.day)}T${s.time}` <= current ? 'past' : s.status })).sort((a, b) => a.day - b.day || a.time.localeCompare(b.time)) };
}
export async function readSchedule(env) {
  if (!env.DB) return null;
  const row = await env.DB.prepare('SELECT data, revision FROM schedule WHERE id = 1').first();
  if (!row) return null;
  const data = JSON.parse(row.data);
  if (!validateSchedule(data)) throw new Error('Invalid saved schedule');
  return { data, revision: row.revision };
}
