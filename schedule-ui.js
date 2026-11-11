(() => {
  if (!bookingOrigin || location.protocol === 'file:') return;
  const title = document.querySelector('#weekTitle'), area = document.querySelector('#scheduleArea');
  const prev = document.querySelector('#previousWeek'), next = document.querySelector('#nextWeek');
  const clearButton = document.querySelector('#clearSlot');
  const dateInput = document.querySelector('#slotDate'), timeInput = document.querySelector('#slotTime');
  const selectedTime = document.querySelector('#selectedTime');
  let firstWeek, firstDate, offset = 0, loading = false, selected = null;
  const lastPage = 8;
  const shift = (date, days) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const label = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  function todayInZone(timeZone) {
    const format = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = Object.fromEntries(format.formatToParts(new Date()).map(({type, value}) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function updateScrollHint() {
    const grid = area.querySelector('.schedule-grid');
    if (!grid) return;
    const hasOverflow = grid.scrollWidth > grid.clientWidth;
    area.querySelector('.schedule-scroll-hint').hidden = !hasOverflow;
    grid.tabIndex = hasOverflow ? 0 : -1;
  }
  const clear = () => {
    delete document.querySelector('#bookingForm').dataset.requestId;
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
  window.addEventListener('resize', updateScrollHint);
  async function fetchWeek(week) {
    const url = new URL('/api/schedule', bookingOrigin);
    if (week) url.searchParams.set('week', week);
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Schedule unavailable');
    return response.json();
  }
  async function load(targetOffset = 0) {
    if (loading) return;
    loading = true; prev.disabled = next.disabled = true; area.textContent = 'Загружаем расписание…';
    try {
      const first = firstWeek ? null : await fetchWeek();
      if (first) {
        firstWeek = first.week;
        firstDate = todayInZone(first.timeZone);
      }
      const week = shift(firstWeek, targetOffset * 7);
      const start = shift(firstDate, targetOffset * 7);
      const end = shift(targetOffset === lastPage ? week : start, 6);
      const nextWeek = shift(week, 7);
      const [data, following] = await Promise.all([
        first ?? fetchWeek(week),
        end >= nextWeek ? fetchWeek(nextWeek) : null,
      ]);
      const slots = [...data.slots, ...(following?.slots ?? [])].filter(
        slot => slot.status !== 'past' && slot.date >= start && slot.date <= end
      );
      offset = targetOffset;
      title.textContent = `${label(start)} — ${label(end)}`;
      document.querySelector('#scheduleZone').textContent = `Время занятий: ${data.timeZone}. Время подтвердит Мария.`;
      area.replaceChildren();
      if (!slots.length) { area.textContent = 'На эти даты часы пока не опубликованы. Можно оставить заявку и согласовать время лично.'; return; }
      const hint = document.createElement('p');
      hint.className = 'schedule-scroll-hint';
      hint.textContent = 'Прокрутите таблицу вбок, чтобы увидеть остальные дни.';
      const grid = document.createElement('div');
      grid.className = 'schedule-grid';
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
      const dates = [...new Set(slots.map(slot => slot.date))].sort();
      for (const date of dates) {
        const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
        const dayLabel = `${['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][weekday]}, ${label(date)}`;
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = dayLabel;
        header.append(th);
      }
      const slotsByDateAndTime = new Map(slots.map(slot => [`${slot.date}T${slot.time}`, slot]));
      const times = [...new Set(slots.map(slot => slot.time))].sort();
      for (const time of times) {
        const row = body.insertRow();
        const rowHeader = document.createElement('th');
        rowHeader.scope = 'row';
        rowHeader.textContent = time;
        row.append(rowHeader);
        for (const date of dates) {
          const cell = row.insertCell();
          const slot = slotsByDateAndTime.get(`${date}T${time}`);
          if (!slot) {
            cell.textContent = '—';
            continue;
          }
          const button = document.createElement('button'); button.type = 'button'; button.className = 'slot';
          const state = slot.status === 'free' ? 'свободно' : 'занято';
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
      updateScrollHint();
    } catch { area.textContent = 'Расписание временно недоступно. Можно оставить заявку без выбора времени.'; }
    finally { loading = false; prev.disabled = !firstWeek || offset <= 0; next.disabled = !firstWeek || offset >= lastPage; }
  }
  prev.addEventListener('click', () => { if (offset > 0) { clear(); load(offset - 1); } });
  next.addEventListener('click', () => { if (offset < lastPage) { clear(); load(offset + 1); } });
  document.addEventListener('booking-saved', () => { clear(); load(offset); });
  document.querySelector('#refreshSchedule')?.addEventListener('click', () => { clear(); load(offset); });
  clearButton.hidden = true;
  load();
})();
