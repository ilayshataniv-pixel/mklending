(() => {
  if (!bookingOrigin || location.protocol === 'file:') return;
  const title = document.querySelector('#weekTitle'), area = document.querySelector('#scheduleArea');
  const prev = document.querySelector('#previousWeek'), next = document.querySelector('#nextWeek');
  const clearButton = document.querySelector('#clearSlot');
  const dateInput = document.querySelector('#slotDate'), timeInput = document.querySelector('#slotTime');
  const selectedTime = document.querySelector('#selectedTime');
  let week, firstWeek, offset = 0, loading = false, selected = null;
  const shift = (date, days) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const label = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const clear = () => {
    selected = null;
    dateInput.value = '';
    timeInput.value = '';
    selectedTime.value = 'Согласовать лично';
    clearButton.hidden = true;
    area.querySelectorAll('.slot.selected').forEach(button => {
      button.classList.remove('selected');
      button.setAttribute('aria-pressed', 'false');
      button.querySelector('span').textContent = 'свободно';
    });
  };
  clearButton.addEventListener('click', clear);
  document.querySelector('#bookingForm').addEventListener('reset', clear);
  async function load(target) {
    if (loading) return;
    loading = true; prev.disabled = next.disabled = true; area.textContent = 'Загружаем расписание…';
    try {
      const url = new URL('/api/schedule', bookingOrigin);
      if (target) url.searchParams.set('week', target);
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const data = await response.json(); week = data.week; firstWeek ||= week;
      offset = Math.round((new Date(`${week}T12:00:00Z`) - new Date(`${firstWeek}T12:00:00Z`)) / 604800000);
      title.textContent = `${label(week)} — ${label(shift(week, 6))}`;
      document.querySelector('#scheduleZone').textContent = `Время занятий: ${data.timeZone}. Время подтвердит Мария.`;
      area.replaceChildren();
      if (!data.slots.length) { area.textContent = 'На эту неделю свободные часы пока не опубликованы. Можно оставить заявку и согласовать время лично.'; return; }
      const hint = document.createElement('p');
      hint.className = 'schedule-scroll-hint';
      hint.textContent = 'Прокрутите таблицу вбок, чтобы увидеть остальные дни.';
      const grid = document.createElement('div');
      grid.className = 'schedule-grid';
      grid.tabIndex = 0;
      grid.setAttribute('role', 'region');
      grid.setAttribute('aria-label', 'Расписание на неделю');
      const table = document.createElement('table');
      table.className = 'schedule-table';
      const caption = document.createElement('caption'); caption.textContent = 'Нажмите на свободное время'; table.append(caption);
      const header = table.createTHead().insertRow();
      const timeHeader = document.createElement('th');
      timeHeader.scope = 'col';
      timeHeader.textContent = 'Время';
      header.append(timeHeader);
      const body = table.createTBody();
      for (let day = 0; day < 7; day++) {
        const dayLabel = `${['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][day]}, ${label(shift(week, day))}`;
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = dayLabel;
        header.append(th);
      }
      const slotsByDayAndTime = new Map(data.slots.map(slot => [`${slot.day}/${slot.time}`, slot]));
      const times = [...new Set(data.slots.map(slot => slot.time))].sort();
      for (const time of times) {
        const row = body.insertRow();
        const rowHeader = document.createElement('th');
        rowHeader.scope = 'row';
        rowHeader.textContent = time;
        row.append(rowHeader);
        for (let day = 0; day < 7; day++) {
          const cell = row.insertCell();
          const slot = slotsByDayAndTime.get(`${day}/${time}`);
          if (!slot) {
            cell.textContent = '—';
            continue;
          }
          const button = document.createElement('button'); button.type = 'button'; button.className = 'slot';
          const state = slot.status === 'free' ? 'свободно' : slot.status === 'past' ? 'прошло' : 'занято';
          const active = selected?.date === slot.date && selected?.time === slot.time && slot.status === 'free';
          const badge = document.createElement('span');
          badge.textContent = active ? 'выбрано' : state;
          button.append(slot.time, badge);
          button.disabled = slot.status !== 'free';
          button.setAttribute('aria-label', `${label(slot.date)}, ${slot.time}, ${data.timeZone}, ${state}`);
          button.classList.toggle('selected', active);
          if (!button.disabled) button.setAttribute('aria-pressed', String(active));
          button.addEventListener('click', () => {
            clear();
            selected = { date: slot.date, time: slot.time };
            button.classList.add('selected');
            button.setAttribute('aria-pressed', 'true');
            badge.textContent = 'выбрано';
            dateInput.value = slot.date;
            timeInput.value = slot.time;
            selectedTime.value = `${label(slot.date)}, ${slot.time} (${data.timeZone})`;
            clearButton.hidden = false;
            document.querySelector('#booking').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
          });
          cell.append(button);
        }
      }
      grid.append(table);
      area.append(hint, grid);
    } catch { area.textContent = 'Расписание временно недоступно. Можно оставить заявку без выбора времени.'; }
    finally { loading = false; prev.disabled = !week || offset <= 0; next.disabled = !week || offset >= 8; }
  }
  prev.addEventListener('click', () => { if (offset > 0) { clear(); load(shift(firstWeek, (offset - 1) * 7)); } });
  next.addEventListener('click', () => { if (offset < 8) { clear(); load(shift(firstWeek, (offset + 1) * 7)); } });
  clearButton.hidden = true;
  load();
})();
