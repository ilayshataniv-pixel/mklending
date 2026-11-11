const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Irkutsk' });
const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Irkutsk' });

export function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function dateLabel(value) {
  return dateFormat.format(new Date(`${value}T12:00:00+08:00`));
}

function resourceLink(url, label) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  } catch { return null; }
  const link = element('a', 'text-link', label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

export function lessonCard(lesson) {
  const card = element('article', 'study-card lesson-card');
  const start = new Date(lesson.starts_at * 1000);
  const end = new Date(lesson.ends_at * 1000);
  const cancelled = lesson.cancelled_at !== null;
  const status = cancelled ? 'Отменено' : end <= new Date() ? 'Прошедшее' : start <= new Date() ? 'Сейчас идёт' : 'Запланировано';
  card.append(element('span', cancelled ? 'study-badge' : 'study-badge sage', status));
  const date = element('time', 'lesson-date', dateFormat.format(start));
  date.dateTime = start.toISOString();
  card.append(date, element('h3', '', lesson.title), element('p', 'lesson-time', `${timeFormat.format(start)}–${timeFormat.format(end)} · Иркутск`));
  if (!cancelled && end > new Date()) {
    const link = resourceLink(lesson.meeting_url, 'Подключиться к занятию ↗');
    if (link) card.append(link);
    else card.append(element('p', 'form-note', 'Ссылку для подключения пришлёт Мария.'));
  }
  return card;
}

export function homeworkCard(task, onToggle) {
  const done = task.completed_at !== null;
  const card = element('article', 'study-card homework-card');
  card.dataset.homeworkId = task.id;
  card.append(element('span', done ? 'study-badge sage' : 'study-badge', done ? 'Выполнено' : 'Нужно сделать'));
  card.append(element('h3', '', task.title));
  if (task.due_date) card.append(element('p', 'form-note', `Срок — ${dateLabel(task.due_date)}`));
  if (task.instructions) card.append(element('p', 'homework-instructions', task.instructions));
  const link = resourceLink(task.resource_url, 'Открыть материалы ↗');
  if (link) card.append(link);
  if (done) card.append(element('p', 'form-note', `Отмечено выполненным ${dateFormat.format(new Date(task.completed_at * 1000))}`));
  if (onToggle) {
    const button = element('button', done ? 'button-link' : 'btn', done ? 'Вернуть в работу' : 'Отметить выполненным');
    button.type = 'button';
    button.addEventListener('click', () => onToggle(task, button));
    card.append(button);
  }
  return card;
}

export function bookingCard(booking, onCancel) {
  const labels = { pending: 'Ожидает подтверждения', confirmed: 'Подтверждена', declined: 'Отклонена', cancelled: 'Отменена' };
  const card = element('article', 'study-card booking-card');
  card.dataset.bookingId = booking.id;
  card.append(element('span', booking.status === 'confirmed' ? 'study-badge sage' : 'study-badge', labels[booking.status]));
  card.append(element('h3', '', booking.lesson_type === 'trial' ? 'Пробный урок' : 'Обычное занятие'));
  if (booking.starts_at !== null) {
    const start = new Date(booking.starts_at * 1000);
    card.append(element('p', '', `${dateFormat.format(start)} · ${timeFormat.format(start)} · Иркутск`));
  } else card.append(element('p', '', 'Время согласуем лично'));
  card.append(element('p', 'form-note', `${booking.duration} минут`));
  if (booking.status === 'pending' && onCancel) {
    const cancel = element('button', 'button-link', 'Отменить заявку');
    cancel.type = 'button';
    cancel.addEventListener('click', () => onCancel(booking, cancel));
    card.append(cancel);
  }
  return card;
}
