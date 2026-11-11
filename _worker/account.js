const errorMessages = {
  credentials: 'Проверьте email и пароль.',
  email_exists: 'Этот email уже зарегистрирован. Попробуйте войти.',
  invalid: 'Проверьте данные. Пароль должен содержать от 12 до 128 символов.',
  invalid_email: 'Проверьте email.',
  invalid_name: 'Введите имя длиной до 80 символов.',
  invalid_reset: 'Ссылка недействительна или истекла. Проверьте email или запросите новую ссылку.',
  limit: 'Слишком много попыток. Повторите через минуту.',
  recovery_unavailable: 'Отправка писем пока недоступна. Попробуйте позже.',
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

async function deriveCredential(email, password) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = encoder.encode(`mklending:student:v2:${email.trim().toLowerCase()}`);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
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
    document.querySelector('#forgotPassword').hidden = true;
  }
  if (location.protocol !== 'file:') {
    submit.disabled = false;
    setAccountStatus(status);
    if (!registering) {
      fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(10000) })
        .then(response => response.ok ? response.json() : {})
        .then(config => { document.querySelector('#forgotPassword').hidden = config.recoveryEnabled !== true; })
        .catch(() => {});
    }
    authForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      setAccountStatus(status, registering ? 'Создаём аккаунт…' : 'Входим…');
      try {
        const { password, ...profile } = Object.fromEntries(new FormData(authForm));
        const credential = await deriveCredential(profile.email, password);
        const endpoint = registering ? '/register' : '/login';
        try {
          await accountRequest(endpoint, 'POST', { ...profile, credential });
        } catch (error) {
          if (registering || error.message !== 'legacy_credentials') throw error;
          await accountRequest(endpoint, 'POST', { ...profile, credential, password });
        }
        location.replace(accountUrl);
      } catch (error) {
        reportError(status, error);
        submit.disabled = false;
      }
    });
  }
}

const recoveryForm = document.querySelector('#recoveryForm');
if (recoveryForm && location.protocol !== 'file:') {
  // A reset link can be opened in the tab that already shows the request form.
  window.addEventListener('hashchange', () => { if (location.hash) location.reload(); });
  const token = location.hash.slice(1);
  const resetting = /^[A-Za-z0-9_-]{43}$/.test(token);
  const status = document.querySelector('#recoveryStatus');
  const submit = recoveryForm.querySelector('button[type=submit]');
  const hint = document.querySelector('#recoveryHint');
  const requestAgain = document.querySelector('#requestAgain');
  if (token) history.replaceState(null, '', location.pathname);
  if (resetting) {
    document.title = 'Новый пароль · Мария / English';
    document.querySelector('#recoveryTitle').textContent = 'Новый пароль';
    hint.textContent = 'Введите email аккаунта и придумайте новый пароль.';
    recoveryForm.querySelectorAll('[data-reset-field]').forEach(field => {
      field.hidden = false;
      field.querySelector('input').disabled = false;
    });
    submit.textContent = 'Сохранить пароль';
    requestAgain.hidden = false;
  }
  submit.disabled = false;
  setAccountStatus(status, token && !resetting ? errorMessages.invalid_reset : '', token && !resetting ? 'error' : '');

  recoveryForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    const { email, password, confirmation } = Object.fromEntries(new FormData(recoveryForm));
    if (resetting && password !== confirmation) {
      setAccountStatus(status, 'Пароли не совпадают.', 'error');
      recoveryForm.elements.confirmation.focus();
      return;
    }
    submit.disabled = true;
    setAccountStatus(status, resetting ? 'Сохраняем пароль…' : 'Запрашиваем ссылку…');
    try {
      if (resetting) {
        const credential = await deriveCredential(email, password);
        await accountRequest('/reset', 'POST', { email, token, credential });
        recoveryForm.reset();
        recoveryForm.hidden = true;
        hint.hidden = true;
        requestAgain.hidden = true;
        setAccountStatus(status, 'Пароль изменён. Теперь можно войти с новым паролем.', 'success');
      } else {
        await accountRequest('/recovery', 'POST', { email });
        setAccountStatus(status, 'Если этот email зарегистрирован, на него придёт ссылка для сброса пароля.', 'success');
        submit.disabled = false;
      }
    } catch (error) {
      reportError(status, error);
      submit.disabled = false;
    }
  });
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
    const bookingName = document.querySelector('#bookingForm input[name=name]');
    if (bookingName) bookingName.value = bookingName.defaultValue = profile.name;
    const bookingContact = document.querySelector('#bookingForm input[name=contact]');
    if (bookingContact && !bookingContact.value) bookingContact.value = profile.email;
    if (bookingContact) bookingContact.defaultValue = profile.email;
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

