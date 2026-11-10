import { addDays, weekStart, validDate, localNow } from './schedule.mjs';
const $ = selector => document.querySelector(selector);
const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const dayLabel = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
let key = '', state, draft = [], inherited = false, dirty = false, busy = false;
const clone = value => structuredClone(value);
const message = text => { $('#status').textContent = text; };
async function api(method, body) {
  const response = await fetch('/api/admin/schedule', { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(response.status === 409 ? 'Другая вкладка уже изменила расписание. Войдите заново, чтобы загрузить актуальную версию.' : response.status === 401 ? 'Неверный ключ доступа.' : response.status === 429 ? 'Слишком много запросов. Подождите минуту.' : 'Не удалось загрузить или сохранить расписание.');
  return response.json();
}
const isTemplate = () => $('#mode').value === 'template';
function remember() {
  if (isTemplate()) state.data.template = clone(draft);
  else if (!inherited) state.data.weeks[$('#week').value] = clone(draft);
}
function edit() { inherited = false; dirty = true; message('Есть несохранённые изменения.'); }
function loadDraft() {
  const week = $('#week').value;
  inherited = !isTemplate() && !Object.hasOwn(state.data.weeks, week);
  draft = clone(isTemplate() ? state.data.template : inherited ? state.data.repeat ? state.data.template : [] : state.data.weeks[week]);
  render();
}
function render() {
  $('#weekLabel').hidden = isTemplate(); $('#copy').hidden = $('#inherit').hidden = isTemplate();
  $('#source').textContent = isTemplate() ? 'Изменения базы применяются к неделям без отдельных настроек.' : inherited ? 'Эта неделя ещё не заполнена. Добавьте время или скопируйте предыдущую неделю.' : 'Для этой недели сохранены отдельные настройки.';
  $('#days').replaceChildren();
  for (let day = 0; day < 7; day++) {
    const box = document.createElement('div'); box.className = 'day';
    const heading = document.createElement('strong');
    const date = new Date(`${addDays($('#week').value, day)}T12:00:00Z`);
    heading.textContent = isTemplate() ? weekdays[day] : `${weekdays[day]}, ${dayLabel.format(date)}`;
    box.append(heading);
    draft.filter(s => s.day === day).forEach(slot => {
      const row = document.createElement('div'); row.className = 'slot';
      const time = document.createElement('input'); time.type = 'time'; time.value = slot.time; time.required = true; time.setAttribute('aria-label', `Время, ${heading.textContent}`);
      time.addEventListener('change', () => { slot.time = time.value; edit(); });
      const status = document.createElement('select'); status.setAttribute('aria-label', `Доступность, ${heading.textContent}`);
      for (const [value, label] of [['free','Свободно'],['taken','Занято']]) { const option = new Option(label,value); status.append(option); } status.value = slot.status;
      status.addEventListener('change', () => { slot.status = status.value; edit(); });
      const remove = document.createElement('button'); remove.textContent = 'Убрать'; remove.addEventListener('click', () => { draft.splice(draft.indexOf(slot),1); edit(); render(); });
      row.append(time,status,remove); box.append(row);
    });
    const add = document.createElement('button'); add.textContent = '+ Добавить время'; add.addEventListener('click', () => { draft.push({ day, time: '10:00', status: 'free' }); edit(); render(); }); box.append(add); $('#days').append(box);
  }
}
$('#login').addEventListener('submit', async event => { event.preventDefault(); key = $('#key').value; try { state = await api('GET'); $('#key').value = ''; $('#zone').value = state.data.timeZone; if (!$('#zone').value) { $('#zone').add(new Option(state.data.timeZone,state.data.timeZone)); $('#zone').value = state.data.timeZone; } $('#repeat').checked = state.data.repeat; $('#week').value = weekStart(localNow(state.data.timeZone).slice(0,10)); $('#login').hidden = true; $('#editor').hidden = false; dirty = false; loadDraft(); message('Расписание загружено.'); } catch (error) { key = ''; message(error.message); } });
let previousWeek, previousMode;
$('#week').addEventListener('focus', () => { previousWeek = $('#week').value; });
$('#week').addEventListener('change', () => {
  const value = $('#week').value;
  if (!validDate(value)) {
    $('#week').value = previousWeek;
    message('Выберите дату в календаре.');
    return;
  }
  if (!inherited && previousWeek) state.data.weeks[previousWeek] = clone(draft);
  $('#week').value = weekStart(value);
  loadDraft();
  previousWeek = $('#week').value;
});
$('#mode').addEventListener('focus', () => { previousMode = $('#mode').value; });
$('#mode').addEventListener('change', () => { if (previousMode === 'template') state.data.template = clone(draft); else if (!inherited) state.data.weeks[$('#week').value] = clone(draft); loadDraft(); previousMode = $('#mode').value; });
$('#repeat').addEventListener('change', () => { remember(); state.data.repeat = $('#repeat').checked; dirty = true; loadDraft(); message('Есть несохранённые изменения.'); });
$('#zone').addEventListener('change', () => { state.data.timeZone = $('#zone').value; dirty = true; message('Часы сохраняют свои значения в новом часовом поясе. Сохраните изменения.'); });
$('#copy').addEventListener('click', () => { const previous = addDays($('#week').value,-7); draft = clone(state.data.weeks[previous] ?? (state.data.repeat ? state.data.template : [])); edit(); render(); });
$('#inherit').addEventListener('click', () => { delete state.data.weeks[$('#week').value]; dirty = true; loadDraft(); message('Индивидуальные настройки недели сброшены. Сохраните изменения.'); });
$('#save').addEventListener('click', async () => { if (busy || !$('#days').reportValidity()) return; remember(); busy = true; $('#editor').querySelectorAll('button,input,select').forEach(e => e.disabled = true); try { const result = await api('PUT', state); state.revision = result.revision; dirty = false; message('Сохранено. Расписание доступно посетителям.'); } catch (error) { message(error.message); } finally { busy = false; $('#editor').querySelectorAll('button,input,select').forEach(e => e.disabled = false); } });
$('#logout').addEventListener('click', () => { if (dirty && !confirm('Выйти без сохранения изменений?')) return; key = ''; state = null; dirty = false; $('#editor').hidden = true; $('#login').hidden = false; message('Вы вышли.'); });
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
