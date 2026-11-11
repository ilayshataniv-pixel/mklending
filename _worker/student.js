import { element, homeworkCard, lessonCard, bookingCard } from './study-ui.mjs';

const status = document.querySelector('#studyStatus');
const refresh = document.querySelector('#studyRefresh');
const content = document.querySelector('#studyContent');
let loading = false;
let updating = false;

async function studyRequest(method = 'GET', body, path = 'study') {
  const response = await fetch('/api/account/' + path, {
    method,
    cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401) {
    location.replace('/auth.html');
    throw new Error('Войдите в аккаунт.');
  }
  if (!response.ok) throw new Error('Не удалось загрузить или сохранить данные. Попробуйте ещё раз.');
  return response.json();
}

async function cancelBooking(booking, button) {
  if (updating || loading || !confirm('Отменить эту заявку на занятие?')) return;
  updating = true;
  button.disabled = true;
  try {
    await studyRequest('PATCH', { id: booking.id }, 'booking');
    document.dispatchEvent(new CustomEvent('booking-saved'));
  } catch (error) { status.textContent = error.message; status.classList.add('error'); }
  finally { updating = false; button.disabled = false; }
}

function showEmpty(target, text) {
  target.replaceChildren(element('p', 'study-empty', text));
}

async function toggleHomework(task, button) {
  if (updating || loading) return;
  updating = true;
  button.disabled = true;
  status.classList.remove('error');
  status.textContent = 'Сохраняем отметку…';
  try {
    await studyRequest('PATCH', { homeworkId: task.id, completed: task.completed_at === null });
    await loadStudy();
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
  } finally {
    updating = false;
    button.disabled = false;
  }
}

async function loadStudy() {
  if (loading) return;
  loading = true;
  refresh.disabled = true;
  status.textContent = 'Обновляем занятия и задания…';
  status.classList.remove('error');
  try {
    const data = await studyRequest();
    const now = Date.now() / 1000;
    const upcoming = data.lessons.filter(lesson => lesson.cancelled_at === null && lesson.ends_at > now);
    const previous = data.lessons.filter(lesson => lesson.cancelled_at !== null || lesson.ends_at <= now).reverse();
    const next = document.querySelector('#nextLesson');
    if (upcoming.length) next.replaceChildren(lessonCard(upcoming[0]));
    else showEmpty(next, 'Мария назначит занятие после согласования времени. Дата и ссылка появятся здесь.');
    document.querySelector('#otherLessons').hidden = upcoming.length < 2;
    document.querySelector('#lessonList').replaceChildren(...upcoming.slice(1).map(lesson => lessonCard(lesson)));
    document.querySelector('#pastLessons').hidden = previous.length === 0;
    document.querySelector('#pastLessonList').replaceChildren(...previous.map(lesson => lessonCard(lesson)));
    const requests = document.querySelector('#bookingRequests');
    if (data.bookings.length) requests.replaceChildren(...data.bookings.map(booking => bookingCard(booking, cancelBooking)));
    else showEmpty(requests, 'Выберите время в разделе «Записаться». Статус заявки появится здесь.');
    const pending = data.homework.filter(task => task.completed_at === null)
      .sort((a, b) => (a.due_date || '9999-12-31').localeCompare(b.due_date || '9999-12-31'));
    const completed = data.homework.filter(task => task.completed_at !== null)
      .sort((a, b) => b.completed_at - a.completed_at);
    document.querySelector('#pendingCount').textContent = pending.length;
    document.querySelector('#completedCount').textContent = completed.length;
    for (const [selector, tasks, empty] of [
      ['#pendingHomework', pending, 'Невыполненных заданий пока нет. Новые задания от Марии появятся здесь.'],
      ['#completedHomework', completed, 'Когда отметите задание выполненным, оно появится здесь.'],
    ]) {
      const list = document.querySelector(selector);
      if (tasks.length) list.replaceChildren(...tasks.map(task => homeworkCard(task, toggleHomework)));
      else showEmpty(list, empty);
    }
    content.hidden = false;
    status.textContent = '';
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('error');
  } finally {
    loading = false;
    refresh.disabled = false;
  }
}

refresh.addEventListener('click', () => { if (!updating) loadStudy(); });
document.addEventListener('booking-saved', () => { if (!loading) loadStudy(); });
window.addEventListener('pagehide', () => { content.hidden = true; });
window.addEventListener('pageshow', event => { if (event.persisted) loadStudy(); });
loadStudy();
