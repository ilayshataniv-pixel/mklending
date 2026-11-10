const bookingOrigin = document.documentElement.dataset.bookingOrigin ?? location.origin;
const form = document.querySelector('#bookingForm');
const button = document.querySelector('#submitButton');
const status = document.querySelector('#formStatus');
const setStatus = (text, kind = '') => { status.textContent = text; status.className = `status ${kind}`; };
const year = document.querySelector('#year');
if (year) year.textContent = new Date().getFullYear();
const lessonType = document.querySelector('#lesson-type');
const lessonOptions = document.querySelectorAll('input[name="lesson-option"]');
function syncLessonOptions() {
  if (lessonType) lessonOptions.forEach(option => { option.checked = option.value === lessonType.value; });
}
lessonOptions.forEach(option => option.addEventListener('change', () => {
  if (option.checked && lessonType) lessonType.value = option.value;
}));
lessonType?.addEventListener('change', syncLessonOptions);
const requestedLesson = new URLSearchParams(location.search).get('lesson');
if (lessonType && Array.from(lessonType.options).some(option => option.value === requestedLesson)) {
  lessonType.value = requestedLesson;
  syncLessonOptions();
}

let ready = false;
async function loadConfiguration() {
  try {
    const response = await fetch(new URL('/api/config', bookingOrigin), { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('unavailable');
    const config = await response.json();
    ready = config.bookingEnabled === true;
    const prices = config.prices ?? {};
    const regular = ['60', '90'].filter(duration => prices[duration]?.trim())
      .map(duration => `${duration} мин · ${prices[duration]}`).join(' / ');
    for (const [key, price] of Object.entries({ ...prices, regular })) {
      if (price?.trim()) document.querySelectorAll(`[data-price="${key}"]`).forEach(element => { element.textContent = price; });
    }
    button.disabled = !ready;
    setStatus(ready ? '' : 'Приём заявок пока недоступен.');
  } catch {
    setStatus('Приём заявок пока недоступен.');
  }
}
if (bookingOrigin && location.protocol !== 'file:') loadConfiguration();
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!ready || button.disabled || !form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  data.name = data.name.trim(); data.contact = data.contact.trim();
  if (!data.name || !data.contact) { setStatus('Укажите имя и контакт для связи.', 'error'); return; }
  button.disabled = true;
  setStatus('Отправляем заявку…');
  try {
    const response = await fetch(new URL('/api/booking', bookingOrigin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(response.status === 429 ? 'limit' : response.status === 409 ? 'slot' : 'failed');
    form.reset();
    syncLessonOptions();
    setStatus('Заявка отправлена! Мария свяжется с вами по указанному контакту.', 'success');
  } catch (error) {
    setStatus(error.message === 'limit' ? 'Слишком много попыток. Попробуйте чуть позже.' : error.message === 'slot' ? 'Это время уже недоступно. Обновите страницу, выберите другое время или нажмите «Согласовать время лично».' : 'Не удалось подтвердить отправку. Данные остались в форме. Попробуйте позже.', 'error');
  } finally { button.disabled = !ready; }
});
