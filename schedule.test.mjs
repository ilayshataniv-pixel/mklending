import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekStart, publicWeek, validateSchedule, validDate } from './schedule.mjs';
import { scheduleApi } from './schedule-api.mjs';
const base = () => ({ timeZone: 'Asia/Irkutsk', repeat: false, template: [], weeks: { '2026-11-02': [{ day: 3, time: '19:00', status: 'free' }, { day: 3, time: '10:00', status: 'free' }] } });
test('Monday boundaries cross year and reject malformed dates', () => {
  assert.equal(weekStart('2027-01-01'),'2026-12-28');
  assert.equal(validDate('2026-99-99'),false);
  assert.equal(validDate('2026-02-30'),false);
});
test('weekly schedule does not automatically repeat and past slots use Irkutsk time', () => {
  const data = base();
  assert.equal(publicWeek(data,'2026-11-09').slots.length,0);
  const week = publicWeek(data,'2026-11-02',new Date('2026-11-05T04:00:00Z'));
  assert.equal(week.slots.find(s => s.time === '10:00').status,'past');
  assert.equal(week.slots.find(s => s.time === '19:00').status,'free');
});
test('duplicate and invalid slots cannot be saved', () => {
  assert.equal(validateSchedule(base()),true);
  const data = base(); data.weeks['2026-11-02'].push(data.weeks['2026-11-02'][0]);
  assert.equal(validateSchedule(data),false);
  data.weeks = { '2026-11-03': [] }; assert.equal(validateSchedule(data),false);
});
const key = 'a'.repeat(32);
const env = () => ({ DB: { prepare: () => ({ first: async () => null, bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }) }, ADMIN_KEY: key, ADMIN_LIMITER: { limit: async () => ({ success: true }) } });
test('admin requires authentication and origin; new schedules start in Irkutsk', async () => {
  const url = 'https://example.com/api/admin/schedule';
  assert.equal((await scheduleApi(new Request(url,{headers:{'CF-Connecting-IP':'192.0.2.1'}}),env())).status,401);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type':'application/json', 'CF-Connecting-IP':'192.0.2.1' };
  const response = await scheduleApi(new Request(url,{headers}),env());
  assert.equal((await response.json()).data.timeZone,'Asia/Irkutsk');
  assert.equal((await scheduleApi(new Request(url,{method:'PUT',headers,body:JSON.stringify({revision:0,data:base()})}),env())).status,403);
});
test('admin detects concurrent updates and saves manual weekly schedule', async () => {
  const headers = { Authorization:`Bearer ${key}`,Origin:'https://example.com','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1' };
  const request = data => new Request('https://example.com/api/admin/schedule',{method:'PUT',headers,body:JSON.stringify({revision:1,data})});
  assert.equal((await scheduleApi(request(base()),env())).status,200);
  const conflict = env(); conflict.DB.prepare = () => ({ bind: () => ({ run: async () => ({ meta: { changes:0 } }) }) });
  assert.equal((await scheduleApi(request(base()),conflict)).status,409);
  const recurring = base(); recurring.repeat = true;
  assert.equal((await scheduleApi(request(recurring),env())).status,400);
});
