// Set this to the HTTPS address printed by Wrangler after the Worker is deployed.
const serviceOrigin = '';

const menu = document.querySelector('.mobile-navigation');
menu.querySelectorAll('a').forEach(link => link.addEventListener('click', () => { menu.open = false; }));
menu.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !menu.open) return;
  menu.open = false;
  menu.querySelector('summary').focus();
});

const weekControls = document.querySelector('.weekbar');
const schedule = document.querySelector('#scheduleArea');
const booking = document.querySelector('#bookingForm');
weekControls.hidden = true;
booking.hidden = true;

function serviceButton(label, path) {
  const link = document.createElement('a');
  link.className = 'btn';
  link.href = new URL(path, serviceOrigin).href;
  link.textContent = label;
  return link;
}

const accountLinks = document.querySelectorAll('[data-guest]');
if (serviceOrigin) {
  accountLinks.forEach(link => { link.href = new URL(link.getAttribute('href'), serviceOrigin).href; });
  schedule.replaceChildren(serviceButton('Открыть расписание ↗', '/#schedule'));
  const actions = document.querySelector('.telegram-actions');
  const formats = document.querySelectorAll('input[name="lesson-option"]');
  const bookingButton = serviceButton('Перейти к записи ↗', '/#booking');
  formats.forEach(option => option.addEventListener('change', () => {
    if (option.checked) bookingButton.href = new URL(`/?lesson=${option.value}#booking`, serviceOrigin).href;
  }));
  actions.append(bookingButton);
} else {
  accountLinks.forEach(link => { link.hidden = true; });
  schedule.textContent = 'Готовим онлайн-запись. Расписание появится после подключения сервиса.';
  const message = document.createElement('p');
  message.textContent = 'Готовим онлайн-запись.';
  document.querySelector('.telegram-actions').append(message);
}
