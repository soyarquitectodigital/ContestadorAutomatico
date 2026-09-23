const form = document.getElementById('authForm');
const passwordInput = document.getElementById('password');
const confirmInput = document.getElementById('confirm');
const confirmGroup = document.getElementById('confirmGroup');
const confirmError = document.getElementById('confirmError');
const submitBtn = document.getElementById('submitBtn');
const messageBox = document.getElementById('message');
const hint = document.getElementById('hint');
const subtitle = document.getElementById('subtitle');
const capsHint = document.getElementById('capsHint');
const strengthWrap = document.getElementById('strengthWrap');
const strengthFill = document.getElementById('strengthFill');
const strengthText = document.getElementById('strengthText');

let needsSetup = false;

function showMessage(text, type = '') {
  messageBox.textContent = text;
  messageBox.className = `message ${type}`;
}

function setupPasswordVisibility(input, button) {
  button.addEventListener('click', () => {
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    button.classList.toggle('active', !visible);
    button.setAttribute('aria-pressed', String(!visible));
    button.setAttribute('aria-label', visible ? 'Mostrar contraseña' : 'Ocultar contraseña');
    input.focus();
  });
}

setupPasswordVisibility(passwordInput, document.getElementById('togglePassword'));
setupPasswordVisibility(confirmInput, document.getElementById('toggleConfirm'));

function updateStrength() {
  const value = passwordInput.value;
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score += 1;
  if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score += 1;

  const levels = [
    { label: 'Muy débil', color: '#dc2626', width: '20%' },
    { label: 'Débil', color: '#d97706', width: '40%' },
    { label: 'Aceptable', color: '#d97706', width: '60%' },
    { label: 'Buena', color: '#10b981', width: '80%' },
    { label: 'Excelente', color: '#059669', width: '100%' },
  ];
  const level = levels[Math.min(score, levels.length - 1)];
  strengthFill.style.width = value ? level.width : '0';
  strengthFill.style.background = level.color;
  strengthText.textContent = value ? level.label : 'Mínimo 8 caracteres.';
}

function checkConfirm() {
  if (!needsSetup || !confirmInput.value) {
    confirmError.classList.add('hidden');
    confirmInput.classList.remove('invalid');
    return true;
  }
  const matches = passwordInput.value === confirmInput.value;
  confirmError.textContent = matches ? '' : 'Las contraseñas no coinciden.';
  confirmError.classList.toggle('hidden', matches);
  confirmInput.classList.toggle('invalid', !matches);
  return matches;
}

function trackCapsLock(event) {
  const active = event.getModifierState?.('CapsLock');
  capsHint.classList.toggle('hidden', !active);
}

passwordInput.addEventListener('keydown', trackCapsLock);
passwordInput.addEventListener('keyup', trackCapsLock);

passwordInput.addEventListener('input', () => {
  if (needsSetup) updateStrength();
  if (confirmInput.value) checkConfirm();
});

confirmInput.addEventListener('input', () => {
  if (needsSetup) checkConfirm();
});

async function init() {
  const expired = new URLSearchParams(window.location.search).get('expired');
  if (expired) showMessage('Tu sesión expiró. Vuelve a introducir la contraseña.', 'info');

  try {
    const response = await fetch('/api/session');
    const data = await response.json();
    if (data.authenticated) {
      window.location.href = '/dashboard';
      return;
    }
    needsSetup = Boolean(data.needsSetup);
    if (needsSetup) {
      subtitle.textContent = 'Primer inicio: crea tu contraseña maestra';
      confirmGroup.classList.remove('hidden');
      strengthWrap.classList.remove('hidden');
      updateStrength();
      submitBtn.textContent = 'Crear contraseña y entrar';
      hint.textContent = 'La contraseña se guarda cifrada (scrypt) y solo tú la conocerás.';
    }
  } catch {
    showMessage('No se pudo contactar con el servidor.', 'error');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showMessage('');

  const password = passwordInput.value;
  if (needsSetup && !password) {
    showMessage('Introduce una contraseña.', 'error');
    return;
  }
  if (needsSetup && !checkConfirm()) {
    showMessage('Las contraseñas no coinciden.', 'error');
    confirmInput.focus();
    return;
  }

  submitBtn.classList.add('loading');
  submitBtn.disabled = true;
  try {
    const response = await fetch(needsSetup ? '/api/setup' : '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showMessage(data.error || 'No se pudo iniciar sesión.', 'error');
      if (needsSetup) {
        passwordInput.focus();
        passwordInput.select();
      }
      return;
    }
    window.location.href = '/dashboard';
  } catch {
    showMessage('No se pudo contactar con el servidor.', 'error');
  } finally {
    submitBtn.classList.remove('loading');
    submitBtn.disabled = false;
  }
});

init();
