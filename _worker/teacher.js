import { element, homeworkCard, lessonCard, bookingCard } from './study-ui.mjs';
import { localNow } from './schedule.mjs';

const login = document.querySelector('#teacherLogin');
const content = document.querySelector('#teacherContent');
const status = document.querySelector('#teacherStatus');
const studentList = document.querySelector('#studentList');
const studentSearch = document.querySelector('#studentSearch');
const selected = document.querySelector('#selectedStudent');
const forms = [document.querySelector('#lessonForm'), document.querySelector('#homeworkForm')];
const messages = {
  unauthorized: 'Введите действующий ключ преподавателя.',
  limit: 'Слишком много запросов. Повторите через минуту.',
  conflict: 'Время уже занято или заявка обработана. Обновите кабинет и проверьте данные.',
  invalid: 'Проверьте поля. Ссылки должны начинаться с https://.',
  invalid_lesson: 'Проверьте дату, время и ссылку. Занятие должно начинаться в будущем.',
  student_missing: 'Выберите зарегистрированного ученика.',
  missing: 'Запись больше недоступна. Обновите кабинет.',
};
let students = [];
let busy = false;
let version = 0;
let selectedId = '';

function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function hidePrivate() {
  version++;
  content.hidden = true;
  selected.hidden = true;
  login.hidden = false;
  students = [];
  selectedId = '';
  studentSearch.value = '';
  studentList.replaceChildren();
}

async function api(path, method = 'GET', body) {
  const response = await fetch('/api/teacher/' + path, {
    method, cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (response.status === 401) hidePrivate();
  if (!response.ok) throw new Error(messages[data.error] ?? 'Не удалось загрузить или сохранить данные. Повторите попытку.');
  return data;
}

async function perform(action) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button,input,select,textarea').forEach(field => { field.disabled = true; });
  try { await action(); }
  catch (error) { message(error.message, true); }
  finally {
    busy = false;
    document.querySelectorAll('button,input,select,textarea').forEach(field => { field.disabled = field.hasAttribute('data-locked'); });
    studentSearch.disabled = !students.length;
  }
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join('').toLocaleUpperCase('ru');
}

function renderStudents() {
  const query = studentSearch.value.trim().toLocaleLowerCase('ru');
  const matches = students.filter(student => `${student.name} ${student.email}`.toLocaleLowerCase('ru').includes(query));
  document.querySelector('#studentCount').textContent = students.length;
  document.querySelector('#studentSearchStatus').textContent = query ? matches.length ? `Найдено ${matches.length} из ${students.length}` : 'Ученики не найдены. Попробуйте другое имя или email.' : '';
  studentList.replaceChildren(...matches.map(student => {
    const item = document.createElement('li');
    const button = element('button', 'student-choice');
    button.type = 'button';
    button.dataset.studentId = student.id;
    button.setAttribute('aria-pressed', String(student.id === selectedId));
    button.setAttribute('aria-label', `${student.name}, ${student.email}`);
    const avatar = element('span', 'student-initials', initials(student.name));
    avatar.setAttribute('aria-hidden', 'true');
    const identity = element('span', 'student-identity');
    identity.append(element('strong', '', student.name), element('span', '', student.email));
    const arrow = element('span', 'student-choice-arrow', '→');
    arrow.setAttribute('aria-hidden', 'true');
    button.append(avatar, identity, arrow);
    button.addEventListener('click', () => selectStudent(student.id));
    item.append(button);
    return item;
  }));
}

function resetStudentForms() {
  forms.forEach(form => {
    form.reset();
    form.closest('details').open = false;
  });
}

async function selectStudent(id) {
  if (busy || id === selectedId) return;
  if (forms.some(form => form.dataset.dirty) && !confirm('Сменить ученика и очистить несохранённые изменения в формах?')) return;
  await perform(async () => {
    resetStudentForms();
    await loadStudent(id);
    const button = Array.from(studentList.querySelectorAll('button')).find(button => button.dataset.studentId === selectedId);
    button?.focus({ preventScroll: true });
    if (matchMedia('(max-width: 760px)').matches) selected.scrollIntoView({ behavior: 'auto', block: 'start' });
  });
}

function tools(card, actions) {
  const row = element('div', 'teacher-tools');
  for (const [label, action] of actions) {
    const button = element('button', 'button-link', label);
    button.type = 'button';
    button.addEventListener('click', action);
    row.append(button);
  }
  card.append(row);
}

function edit(form, item, kind) {
  form.closest('details').open = true;
  form.reset();
  form.dataset.editId = item.id;
  form.dataset.dirty = 'true';
  form.elements.title.value = item.title;
  if (kind === 'homework') {
    form.elements.instructions.value = item.instructions;
    form.elements.resourceUrl.value = item.resource_url;
    form.elements.dueDate.value = item.due_date;
  } else {
    const date = localNow('Asia/Irkutsk', new Date(item.starts_at * 1000));
    form.elements.date.value = date.slice(0, 10);
    form.elements.time.value = date.slice(11);
    form.elements.duration.value = String((item.ends_at - item.starts_at) / 60);
    form.elements.meetingUrl.value = item.meeting_url;
  }
  form.querySelector('h3').textContent = kind === 'homework' ? 'Редактировать задание' : 'Редактировать занятие';
  form.scrollIntoView({ behavior: 'auto', block: 'start' });
}

async function remove(kind, id) {
  if (!confirm(kind === 'lesson' ? 'Отменить занятие? Ученик увидит отмену в кабинете.' : 'Удалить домашнее задание?')) return;
  await perform(async () => {
    await api('study', 'DELETE', { kind, id, studentId: selectedId });
    if (kind === 'lesson') await loadDashboard();
    else await loadStudent();
    message(kind === 'lesson' ? 'Занятие отменено.' : 'Задание удалено.');
  });
}

async function loadStudent(id = selectedId) {
  const current = ++version;
  selected.hidden = true;
  if (!id) { selectedId = ''; renderStudents(); return; }
  const data = await api('study?studentId=' + encodeURIComponent(id));
  if (current !== version) return;
  selectedId = id;
  renderStudents();
  document.querySelector('#selectedStudentName').textContent = data.student.name;
  document.querySelector('#selectedStudentEmail').textContent = data.student.email;
  document.querySelector('#selectedStudentInitials').textContent = initials(data.student.name);
  document.querySelector('#studentUpcomingCount').textContent = data.lessons.filter(lesson => lesson.cancelled_at === null && lesson.ends_at > Date.now() / 1000).length;
  document.querySelector('#studentPendingCount').textContent = data.homework.filter(task => task.completed_at === null).length;
  document.querySelector('#studentDoneCount').textContent = data.homework.filter(task => task.completed_at !== null).length;
  const lessons = data.lessons.map(lesson => {
    const card = lessonCard(lesson);
    if (lesson.cancelled_at === null && lesson.ends_at > Date.now() / 1000) tools(card, [
      ['Изменить занятие', () => edit(forms[0], lesson, 'lesson')],
      ['Отменить занятие', () => remove('lesson', lesson.id)],
    ]);
    return card;
  });
  document.querySelector('#teacherLessons').replaceChildren(...(lessons.length ? lessons : [element('p', 'study-empty', 'Занятия пока не назначены.')]));
  const homework = data.homework.map(task => {
    const card = homeworkCard(task);
    tools(card, [['Изменить задание', () => edit(forms[1], task, 'homework')], ['Удалить задание', () => remove('homework', task.id)]]);
    return card;
  });
  document.querySelector('#teacherHomework').replaceChildren(...(homework.length ? homework : [element('p', 'study-empty', 'Домашних заданий пока нет.')]));
  selected.hidden = false;
}

function requestCard(request) {
  const card = bookingCard(request);
  card.append(element('p', '', `${request.name} · ${request.contact}`), element('p', 'form-note', request.goal));
  if (request.message) card.append(element('p', 'homework-instructions', request.message));
  const template = document.querySelector('#requestConfirmTemplate').content.cloneNode(true);
  const form = template.querySelector('form');
  form.elements.studentId.append(new Option('Выберите аккаунт ученика', ''), ...students.map(student => new Option(`${student.name} · ${student.email}`, student.id)));
  if (request.user_id) {
    form.elements.studentId.value = request.user_id;
    form.elements.studentId.disabled = true;
    form.elements.studentId.setAttribute('data-locked', '');
  }
  form.elements.title.value = request.lesson_type === 'trial' ? 'Пробный урок' : 'Английский с Марией';
  form.elements.duration.value = String(request.duration);
  if (request.starts_at !== null) {
    const date = localNow('Asia/Irkutsk', new Date(request.starts_at * 1000));
    form.elements.date.value = date.slice(0, 10);
    form.elements.time.value = date.slice(11);
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const body = { ...Object.fromEntries(new FormData(form)), id: request.id, action: 'confirm' };
    body.duration = Number(body.duration);
    perform(async () => {
      await api('request', 'PATCH', body);
      await loadDashboard();
      message('Занятие подтверждено и появилось у ученика.');
    });
  });
  card.append(template);
  tools(card, [['Отклонить заявку', () => {
    if (!confirm('Отклонить заявку? Выбранное время снова станет доступно.')) return;
    perform(async () => {
      await api('request', 'PATCH', { id: request.id, action: 'decline' });
      await loadDashboard();
      message('Заявка отклонена.');
    });
  }]]);
  return card;
}

async function loadDashboard() {
  const data = await api('dashboard');
  students = data.students;
  const targetId = students.some(student => student.id === selectedId) ? selectedId : students[0]?.id ?? '';
  if (targetId !== selectedId) resetStudentForms();
  renderStudents();
  document.querySelector('#noStudents').hidden = students.length > 0;
  document.querySelector('#studentDirectory').hidden = students.length === 0;
  document.querySelector('#requestCount').textContent = data.requests.length;
  document.querySelector('#requestList').replaceChildren(...(data.requests.length ? data.requests.map(requestCard) : [element('p', 'study-empty', 'Новых заявок пока нет.')]));
  const calendar = data.lessons.map(lesson => {
    const card = lessonCard(lesson);
    card.prepend(element('p', 'form-note', `${lesson.name} · ${lesson.email}`));
    return card;
  });
  document.querySelector('#teacherCalendarList').replaceChildren(...(calendar.length ? calendar : [element('p', 'study-empty', 'Ближайшие занятия появятся после назначения.')]));
  login.hidden = true;
  content.hidden = false;
  await loadStudent(targetId);
}

login.addEventListener('submit', event => {
  event.preventDefault();
  const key = document.querySelector('#teacherKey').value;
  perform(async () => {
    await api('login', 'POST', { key });
    document.querySelector('#teacherKey').value = '';
    await loadDashboard();
    message('Кабинет загружен.');
  });
});
studentSearch.addEventListener('input', renderStudents);
for (const [index, kind] of [[0, 'lesson'], [1, 'homework']]) {
  const form = forms[index];
  form.addEventListener('input', () => { form.dataset.dirty = 'true'; delete form.dataset.requestId; });
  form.addEventListener('reset', () => {
    delete form.dataset.editId;
    delete form.dataset.requestId;
    delete form.dataset.dirty;
    form.querySelector('h3').textContent = kind === 'lesson' ? 'Назначить занятие' : 'Добавить домашнее задание';
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    form.dataset.requestId ||= crypto.randomUUID();
    const body = { ...Object.fromEntries(new FormData(form)), kind, studentId: selectedId, id: form.dataset.editId ?? form.dataset.requestId };
    if (kind === 'lesson') body.duration = Number(body.duration);
    const method = form.dataset.editId ? 'PATCH' : 'POST';
    perform(async () => {
      await api('study', method, body);
      form.reset();
      form.closest('details').open = false;
      if (kind === 'lesson') await loadDashboard();
      else await loadStudent();
      message(kind === 'lesson' ? 'Занятие сохранено.' : 'Задание сохранено.');
    });
  });
}
document.querySelector('#teacherRefresh').addEventListener('click', () => perform(async () => { await loadDashboard(); message('Данные обновлены.'); }));
document.querySelector('#teacherLogout').addEventListener('click', () => perform(async () => { await api('logout', 'POST'); hidePrivate(); message('Вы вышли.'); }));
window.addEventListener('pagehide', () => { content.hidden = true; });
window.addEventListener('pageshow', event => { if (event.persisted) perform(loadDashboard); });
perform(async () => {
  const response = await fetch('/api/teacher/session', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (response.ok) await loadDashboard();
});
