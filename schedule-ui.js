(() => {
  const title = document.querySelector('#weekTitle'), area = document.querySelector('#scheduleArea');
  const prev = document.querySelector('#previousWeek'), next = document.querySelector('#nextWeek');
  let week, firstWeek, offset = 0, loading = false, selected = null;
  const shift = (date, days) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const label = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const clear = () => { selected = null; document.querySelector('#slotDate').value = ''; document.querySelector('#slotTime').value = ''; document.querySelector('#selectedTime').value = 'Согласовать лично'; document.querySelectorAll('.slot.selected').forEach(b => b.classList.remove('selected')); };
  document.querySelector('#clearSlot').addEventListener('click', clear);
  document.querySelector('#bookingForm').addEventListener('reset', clear);
  async function load(target) {
    if (loading) return;
    loading = true; prev.disabled = next.disabled = true; area.textContent = 'Загружаем расписание…';
    try {
      const response = await fetch(`/api/schedule${target ? `?week=${target}` : ''}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const data = await response.json(); week = data.week; firstWeek ||= week;
      offset = Math.round((new Date(`${week}T12:00:00Z`) - new Date(`${firstWeek}T12:00:00Z`)) / 604800000);
      title.textContent = `${label(week)} — ${label(shift(week, 6))}`;
      document.querySelector('#scheduleZone').textContent = `Время занятий: ${data.timeZone}. Время подтвердит Мария.`;
      area.replaceChildren();
      if (!data.slots.length) { area.textContent = 'На эту неделю свободные часы пока не опубликованы. Можно оставить заявку и согласовать время лично.'; return; }
      const table = document.createElement('table'); table.className = 'schedule-table';
      const caption = document.createElement('caption'); caption.textContent = 'Нажмите на свободное время'; table.append(caption);
      const header = table.createTHead().insertRow();
      for (let day = 0; day < 7; day++) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = `${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'][day]}, ${label(shift(week, day))}`; header.append(th); }
      const row = table.createTBody().insertRow();
      for (let day = 0; day < 7; day++) {
        const cell = row.insertCell();
        const slots = data.slots.filter(s => s.day === day);
        if (!slots.length) cell.textContent = '—';
        for (const slot of slots) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'slot';
          const state = slot.status === 'free' ? 'свободно' : slot.status === 'past' ? 'прошло' : 'занято';
          button.textContent = `${slot.time} · ${state}`; button.disabled = slot.status !== 'free';
          button.setAttribute('aria-label', `${label(slot.date)}, ${slot.time}, ${data.timeZone}, ${state}`);
          if (selected?.date === slot.date && selected?.time === slot.time && !button.disabled) button.classList.add('selected');
          button.addEventListener('click', () => { clear(); selected = { date: slot.date, time: slot.time }; button.classList.add('selected'); document.querySelector('#slotDate').value = slot.date; document.querySelector('#slotTime').value = slot.time; document.querySelector('#selectedTime').value = `${label(slot.date)}, ${slot.time} (${data.timeZone})`; document.querySelector('#booking').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); });
          cell.append(button);
        }
      }
      area.append(table);
    } catch { area.textContent = 'Расписание временно недоступно. Можно оставить заявку без выбора времени.'; }
    finally { loading = false; prev.disabled = !week || offset <= 0; next.disabled = !week || offset >= 8; }
  }
  prev.addEventListener('click', () => { if (offset > 0) { clear(); load(shift(firstWeek, (offset - 1) * 7)); } });
  next.addEventListener('click', () => { if (offset < 8) { clear(); load(shift(firstWeek, (offset + 1) * 7)); } });
  load();
})();
