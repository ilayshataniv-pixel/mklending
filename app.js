const form = document.querySelector('#bookingForm');
const button = document.querySelector('#submitButton');
const status = document.querySelector('#formStatus');
const setStatus = (text, kind = '') => { status.textContent = text; status.className = `status ${kind}`; };
document.querySelector('#year').textContent = new Date().getFullYear();
let ready = false;
async function loadConfiguration() {
  try {
    const response = await fetch('/api/config', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('unavailable');
    const config = await response.json();
    ready = config.bookingEnabled === true;
    if (/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(config.telegramUsername || '')) {
      const link = document.querySelector('#directContact');
      link.href = `https://t.me/${config.telegramUsername}`;
      link.hidden = false;
    }
    for (const duration of ['60', '90']) {
      if (typeof config.prices?.[duration] === 'string' && config.prices[duration].trim()) {
        document.querySelector(`[data-price="${duration}"]`).textContent = config.prices[duration];
      }
    }
    button.disabled = !ready;
    setStatus(ready ? '' : 'Запись через форму пока недоступна.');
  } catch {
    setStatus('Запись через форму пока недоступна.');
  }
}
loadConfiguration();
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!ready || button.disabled || !form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  data.name = data.name.trim(); data.contact = data.contact.trim();
  if (!data.name || !data.contact) { setStatus('Укажите имя и Telegram для связи.', 'error'); return; }
  button.disabled = true;
  setStatus('Отправляем заявку…');
  try {
    const response = await fetch('/api/booking', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(response.status === 429 ? 'limit' : 'failed');
    form.reset();
    setStatus('Заявка отправлена! Мария свяжется с вами по указанному контакту.', 'success');
  } catch (error) {
    setStatus(error.message === 'limit' ? 'Слишком много попыток. Попробуйте чуть позже.' : 'Не удалось подтвердить отправку. Данные сохранены в форме; попробуйте позже или напишите Марии напрямую.', 'error');
  } finally { button.disabled = !ready; }
});
