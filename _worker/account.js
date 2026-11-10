const errorMessages = {
  credentials: 'Проверьте email и пароль.',
  email_exists: 'Этот email уже зарегистрирован. Попробуйте войти.',
  invalid: 'Проверьте данные. Пароль должен содержать от 12 до 128 символов.',
  invalid_name: 'Введите имя длиной до 80 символов.',
  limit: 'Слишком много попыток. Повторите через минуту.',
  unavailable: 'Аккаунт временно недоступен. Попробуйте позже.',
};
const authUrl = '/auth.html';
const accountUrl = '/account.html';

async function accountRequest(path = '', method = 'GET', data) {
  const response = await fetch('/api/account' + path, {
    method,
    cache: 'no-store',
    ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'unavailable');
  return result;
}

function setAccountStatus(element, text = '', kind = '') {
  element.textContent = text;
  element.classList.toggle('error', kind === 'error');
  element.classList.toggle('success', kind === 'success');
}

function reportError(element, error) {
  setAccountStatus(element, errorMessages[error.message] ?? errorMessages.unavailable, 'error');
}

const menu = document.querySelector('.mobile-navigation');
if (menu) {
  menu.querySelectorAll('a').forEach(link => link.addEventListener('click', () => { menu.open = false; }));
  menu.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menu.querySelector('summary').focus();
  });
  const showNavigation = authenticated => {
    document.querySelectorAll('[data-guest]').forEach(link => { link.hidden = authenticated; });
    document.querySelectorAll('[data-profile]').forEach(link => { link.hidden = !authenticated; });
  };
  if (location.protocol !== 'file:') {
    const refresh = () => accountRequest().then(() => showNavigation(true)).catch(() => showNavigation(false));
    refresh();
    window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
  }
}

const authForm = document.querySelector('#authForm');
if (authForm) {
  const registering = new URLSearchParams(location.search).get('mode') === 'register';
  const password = authForm.elements.password;
  const submit = authForm.querySelector('button[type=submit]');
  const status = document.querySelector('#authStatus');
  if (registering) {
    document.title = 'Регистрация · Мария / English';
    document.querySelector('#authTitle').textContent = 'Регистрация';
    document.querySelector('#registerName').hidden = false;
    authForm.elements.name.disabled = false;
    authForm.elements.name.required = true;
    password.autocomplete = 'new-password';
    password.minLength = 12;
    password.setAttribute('aria-describedby', 'passwordHint');
    document.querySelector('#passwordHint').hidden = false;
    submit.textContent = 'Зарегистрироваться';
    const alternative = document.querySelector('#authAlternative a');
    alternative.href = 'auth.html';
    alternative.textContent = 'Уже есть аккаунт? Войти';
  }
  if (location.protocol !== 'file:') {
    submit.disabled = false;
    setAccountStatus(status);
    authForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      setAccountStatus(status, registering ? 'Создаём аккаунт…' : 'Входим…');
      try {
        await accountRequest(registering ? '/register' : '/login', 'POST', Object.fromEntries(new FormData(authForm)));
        location.replace(accountUrl);
      } catch (error) {
        reportError(status, error);
        submit.disabled = false;
      }
    });
  }
}

const profileForm = document.querySelector('#profileForm');
if (profileForm) {
  const content = document.querySelector('#accountContent');
  const status = document.querySelector('#accountStatus');
  const profileStatus = document.querySelector('#profileStatus');
  const logoutStatus = document.querySelector('#logoutStatus');
  const submit = profileForm.querySelector('button[type=submit]');
  const logout = document.querySelector('#logout');
  function showProfile(profile) {
    document.querySelector('#profileName').textContent = profile.name;
    document.querySelector('#profileEmail').textContent = profile.email;
    profileForm.elements.name.value = profile.name;
    status.hidden = true;
    content.hidden = false;
  }
  async function loadProfile() {
    if (location.protocol === 'file:') {
      setAccountStatus(status, 'Для входа в кабинет откройте сайт через сервер.');
      return;
    }
    try {
      showProfile((await accountRequest()).profile);
    } catch (error) {
      if (error.message === 'unauthorized') location.replace(authUrl);
      else reportError(status, error);
    }
  }
  profileForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    setAccountStatus(profileStatus, 'Сохраняем имя…');
    try {
      showProfile((await accountRequest('', 'PATCH', { name: profileForm.elements.name.value })).profile);
      setAccountStatus(profileStatus, 'Имя сохранено.', 'success');
    } catch (error) {
      if (error.message === 'unauthorized') location.replace(authUrl);
      else reportError(profileStatus, error);
    } finally {
      submit.disabled = false;
    }
  });
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    setAccountStatus(logoutStatus, 'Выходим…');
    try {
      await accountRequest('/logout', 'POST');
      content.hidden = true;
      location.replace('/');
    } catch (error) {
      reportError(logoutStatus, error);
      logout.disabled = false;
    }
  });
  loadProfile();
  window.addEventListener('pagehide', () => { content.hidden = true; });
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      status.hidden = false;
      setAccountStatus(status, 'Загружаем профиль…');
      loadProfile();
    }
  });
}

