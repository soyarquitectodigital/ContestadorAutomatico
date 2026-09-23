const socket = io();
const el = (id) => document.getElementById(id);

const STATUS_META = {
  disconnected: { label: 'Desconectado', className: 'badge-off' },
  connecting: { label: 'Conectando…', className: 'badge-wait' },
  qr: { label: 'Esperando escaneo', className: 'badge-wait' },
  connected: { label: 'Conectado', className: 'badge-on' },
  reconnecting: { label: 'Reconectando…', className: 'badge-warn' },
  logged_out: { label: 'Sesión cerrada', className: 'badge-off' },
  error: { label: 'Error', className: 'badge-error' },
};

const MAX_LOGS = 300;
const TARGET_FIELDS = ['number', 'group', 'keyword', 'response', 'bulk'];
const ACCOUNT_BUSY = ['connecting', 'qr', 'reconnecting'];

const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  error: '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
};

const ICONS = {
  edit: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>',
};

let accounts = [];
let targets = [];
let groupsCache = [];
let editingId = null;
let editingAccountId = null;
let modalMode = 'single';
const expandedAccounts = new Set();
let logs = [];
let logFilter = 'all';
let autoScroll = true;
let confirmResolver = null;

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (response.status === 401) {
    window.location.href = '/login?expired=1';
    throw new Error('Sesión expirada.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || `Error ${response.status}`);
    error.details = data?.errors ?? [];
    throw error;
  }
  return data;
}

/* ---- Notificaciones ---- */
function toast(type, title, message = '') {
  const container = el('toasts');
  const node = document.createElement('div');
  node.className = `toast toast-${type}`;
  node.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] ?? ''}</span><div class="toast-body"><p class="toast-title"></p>${message ? '<p class="toast-message"></p>' : ''}</div><button class="toast-close" type="button" aria-label="Cerrar notificación">×</button>`;
  node.querySelector('.toast-title').textContent = title;
  if (message) node.querySelector('.toast-message').textContent = message;

  const remove = () => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 200);
  };
  node.querySelector('.toast-close').addEventListener('click', remove);
  container.appendChild(node);
  while (container.children.length > 4) container.firstChild.remove();
  setTimeout(remove, 5000);
}

async function withLoading(button, task) {
  if (button.classList.contains('loading')) return undefined;
  button.classList.add('loading');
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.classList.remove('loading');
    button.disabled = false;
  }
}

/* ---- Confirmación ---- */
function confirmDialog({ title, message, confirmText = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    el('modalTitle').textContent = title;
    el('modalText').textContent = message;
    const confirmBtn = el('modalConfirm');
    confirmBtn.textContent = confirmText;
    confirmBtn.className = `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`;
    el('modal').classList.remove('hidden');
    confirmBtn.focus();
    confirmResolver = (value) => {
      el('modal').classList.add('hidden');
      confirmResolver = null;
      resolve(value);
    };
  });
}

el('modalCancel').addEventListener('click', () => confirmResolver?.(false));
el('modalConfirm').addEventListener('click', () => confirmResolver?.(true));
el('modal').addEventListener('click', (event) => {
  if (event.target === el('modal')) confirmResolver?.(false);
});

/* ---- Cuentas de WhatsApp ---- */
function actionButton(label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', () => withLoading(button, handler));
  return button;
}

function iconButton(icon, label, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  return button;
}

function renderAggregate() {
  const total = accounts.length;
  const connected = accounts.filter((account) => account.connected).length;
  let label = 'Desconectado';
  let className = 'badge-off';

  if (accounts.some((account) => account.status === 'qr')) {
    label = 'Esperando escaneo';
    className = 'badge-wait';
  } else if (accounts.some((account) => ACCOUNT_BUSY.includes(account.status) || account.status === 'reconnecting')) {
    label = 'Conectando…';
    className = 'badge-wait';
  } else if (connected > 0) {
    label = `Conectado (${connected}/${total})`;
    className = 'badge-on';
  }

  const badge = el('statusBadge');
  badge.textContent = label;
  badge.className = `badge ${className}`;
}

async function startAccount(account) {
  try {
    await api(`/api/accounts/${account.id}/start`, { method: 'POST' });
    await refreshAccounts();
    toast('info', 'Conectando…', `Escanea el QR de “${account.label}” si es la primera vez.`);
  } catch (error) {
    toast('error', 'No se pudo conectar', error.message);
  }
}

async function stopAccount(account) {
  try {
    await api(`/api/accounts/${account.id}/stop`, { method: 'POST' });
    await refreshAccounts();
    toast('info', 'Número detenido', `“${account.label}” conserva su sesión.`);
  } catch (error) {
    toast('error', 'No se pudo detener', error.message);
  }
}

async function logoutAccount(account) {
  const confirmed = await confirmDialog({
    title: 'Cerrar sesión de WhatsApp',
    message: `Se eliminarán las credenciales de “${account.label}” y tendrás que escanear un nuevo código QR. ¿Continuar?`,
    confirmText: 'Sí, cerrar sesión',
    danger: true,
  });
  if (!confirmed) return;

  try {
    await api(`/api/accounts/${account.id}/logout`, { method: 'POST' });
    await refreshAccounts();
    toast('warn', 'Sesión eliminada', `“${account.label}” necesitará un nuevo QR.`);
  } catch (error) {
    toast('error', 'No se pudo cerrar la sesión', error.message);
  }
}

async function removeAccount(account) {
  const confirmed = await confirmDialog({
    title: 'Eliminar número de WhatsApp',
    message: `Se eliminará “${account.label}” y su sesión vinculada. Sus registros pasarán a “cualquier cuenta”. ¿Continuar?`,
    confirmText: 'Sí, eliminar',
    danger: true,
  });
  if (!confirmed) return;

  try {
    await api(`/api/accounts/${account.id}`, { method: 'DELETE' });
    await Promise.all([refreshAccounts(), refreshTargets()]);
    toast('warn', 'Número eliminado', account.label);
  } catch (error) {
    toast('error', 'No se pudo eliminar', error.message);
  }
}

function accountRow(account) {
  const row = document.createElement('div');
  row.className = 'account-row';
  row.dataset.id = account.id;

  const recordCount = targets.filter((target) => (target.accountId || '') === account.id).length;
  if (['qr', 'connecting', 'reconnecting'].includes(account.status)) expandedAccounts.add(account.id);
  const isExpanded = expandedAccounts.has(account.id);
  row.classList.toggle('expanded', isExpanded);

  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'account-summary';
  summary.setAttribute('aria-expanded', String(isExpanded));

  const main = document.createElement('span');
  main.className = 'account-summary-main';

  const title = document.createElement('span');
  title.className = 'account-title';
  const name = document.createElement('span');
  name.textContent = account.label;
  const meta = STATUS_META[account.status] || STATUS_META.error;
  const statusBadge = document.createElement('span');
  statusBadge.className = `badge badge-sm ${meta.className}`;
  statusBadge.textContent = meta.label;
  title.append(name, statusBadge);

  const detail = document.createElement('span');
  detail.className = 'account-meta';
  detail.textContent = `${account.detail || 'Sin conectar'} · ${recordCount} registro(s)`;

  main.append(title, detail);

  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.innerHTML = ICONS.chevron;

  summary.append(main, chevron);
  row.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'account-body';
  body.classList.toggle('hidden', !isExpanded);

  summary.addEventListener('click', () => {
    const nowExpanded = !expandedAccounts.has(account.id);
    if (nowExpanded) expandedAccounts.add(account.id);
    else expandedAccounts.delete(account.id);
    row.classList.toggle('expanded', nowExpanded);
    body.classList.toggle('hidden', !nowExpanded);
    summary.setAttribute('aria-expanded', String(nowExpanded));
  });

  const actions = document.createElement('div');
  actions.className = 'account-actions-row';

  if (ACCOUNT_BUSY.includes(account.status) || account.status === 'reconnecting') {
    actions.appendChild(actionButton('Detener', 'btn btn-sm', () => stopAccount(account)));
  } else if (account.status === 'connected') {
    actions.appendChild(actionButton('Detener', 'btn btn-sm', () => stopAccount(account)));
    actions.appendChild(actionButton('Cerrar sesión WhatsApp', 'btn btn-sm btn-danger', () => logoutAccount(account)));
  } else {
    const label = account.status === 'logged_out' ? 'Vincular de nuevo' : 'Conectar';
    actions.appendChild(actionButton(label, 'btn btn-sm btn-primary', () => startAccount(account)));
  }

  if (account.status === 'qr') {
    actions.appendChild(actionButton('Cerrar sesión WhatsApp', 'btn btn-sm btn-danger', () => logoutAccount(account)));
  }

  actions.appendChild(actionButton('Renombrar', 'btn btn-sm', () => openAccountModal(account)));
  actions.appendChild(actionButton('Eliminar', 'btn btn-sm btn-danger', () => removeAccount(account)));

  if (account.status === 'qr' && account.qr) {
    const qrBox = document.createElement('div');
    qrBox.className = 'account-qr';
    const img = document.createElement('img');
    img.src = account.qr;
    img.alt = `Código QR de ${account.label}`;
    const steps = document.createElement('ol');
    steps.className = 'qr-steps';
    for (const text of [
      'Abre WhatsApp en el teléfono de ese número.',
      'Entra en Dispositivos vinculados.',
      'Escanea el código. Se renueva solo si expira.',
    ]) {
      const li = document.createElement('li');
      li.textContent = text;
      steps.appendChild(li);
    }
    qrBox.append(img, steps);
    body.appendChild(qrBox);
  } else if (['connecting', 'reconnecting'].includes(account.status)) {
    const loading = document.createElement('div');
    loading.className = 'account-qr';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    const text = document.createElement('p');
    text.className = 'muted';
    text.textContent = account.detail || 'Conectando con WhatsApp…';
    loading.append(spinner, text);
    body.appendChild(loading);
  }

  body.appendChild(actions);
  body.appendChild(accountTargetsSection(account));
  row.appendChild(body);

  return row;
}

function renderAccounts() {
  const list = el('accountsList');
  list.innerHTML = '';
  accounts.forEach((account) => list.appendChild(accountRow(account)));

  const connected = accounts.filter((account) => account.connected).length;
  el('accountsCount').textContent = `${connected} conectados / ${accounts.length}`;
  el('accountsEmpty').classList.toggle('hidden', accounts.length > 0);

  el('stepNumber1').textContent = connected > 0 ? '✓' : '1';
  el('stepNumber1').classList.toggle('done', connected > 0);

  renderAggregate();
}

async function refreshAccounts() {
  accounts = await api('/api/accounts');
  renderAccounts();
}

/* ---- Editor de cuentas ---- */
function openAccountModal(account = null) {
  editingAccountId = account?.id ?? null;
  el('accountModalTitle').textContent = editingAccountId ? 'Editar número de WhatsApp' : 'Agregar número de WhatsApp';
  el('accountModalSave').textContent = editingAccountId ? 'Guardar cambios' : 'Guardar número';
  el('inputAccountLabel').value = account?.label ?? '';
  el('errorAccountLabel').classList.add('hidden');
  el('inputAccountLabel').classList.remove('invalid');
  el('accountModal').classList.remove('hidden');
  el('inputAccountLabel').focus();
}

function closeAccountModal() {
  el('accountModal').classList.add('hidden');
  editingAccountId = null;
}

el('accountForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const label = el('inputAccountLabel').value.trim();
  if (!label) {
    el('errorAccountLabel').textContent = 'Escribe una etiqueta para identificar el número.';
    el('errorAccountLabel').classList.remove('hidden');
    el('inputAccountLabel').classList.add('invalid');
    return;
  }

  await withLoading(el('accountModalSave'), async () => {
    try {
      if (editingAccountId) {
        await api(`/api/accounts/${editingAccountId}`, { method: 'PUT', body: JSON.stringify({ label }) });
      } else {
        await api('/api/accounts', { method: 'POST', body: JSON.stringify({ label }) });
      }
      await refreshAccounts();
      closeAccountModal();
      toast(
        'success',
        editingAccountId ? 'Número actualizado' : 'Número agregado',
        'Pulsa “Conectar” y escanea su código QR.',
      );
    } catch (error) {
      toast('error', 'No se pudo guardar', error.message);
    }
  });
});

el('accountModalCancel').addEventListener('click', closeAccountModal);
el('accountModal').addEventListener('click', (event) => {
  if (event.target === el('accountModal')) closeAccountModal();
});

el('addAccountBtn').addEventListener('click', () => openAccountModal());
el('inputAccountLabel').addEventListener('input', () => {
  el('errorAccountLabel').classList.add('hidden');
  el('inputAccountLabel').classList.remove('invalid');
});

el('startAllBtn').addEventListener('click', async () => {
  await withLoading(el('startAllBtn'), async () => {
    try {
      await api('/api/bot/start', { method: 'POST' });
      await refreshAccounts();
      toast('info', 'Conectando todas las cuentas…', 'Escanea los QR que aparezcan.');
    } catch (error) {
      toast('error', 'No se pudieron conectar', error.message);
    }
  });
});

/* ---- CRUD de números registrados ---- */
function groupLabel(jid) {
  const group = groupsCache.find((item) => item.jid === jid);
  return group ? group.subject : jid;
}

function fillAccountOptions(selectedId = '') {
  const select = el('inputAccount');
  select.innerHTML = '';
  const anyOption = document.createElement('option');
  anyOption.value = '';
  anyOption.textContent = 'Cualquier cuenta conectada';
  select.appendChild(anyOption);

  for (const account of accounts) {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = `${account.label}${account.connected ? ' (conectada)' : ''}`;
    select.appendChild(option);
  }
  select.value = accounts.some((account) => account.id === selectedId) ? selectedId : '';
}

function targetRow(target) {
  const row = document.createElement('div');
  row.className = `target-row${target.enabled ? '' : ' disabled'}`;
  row.dataset.id = target.id;

  const switchLabel = document.createElement('label');
  switchLabel.className = 'switch';
  switchLabel.title = target.enabled ? 'Desactivar registro' : 'Activar registro';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = target.enabled;
  checkbox.setAttribute('aria-label', `Activar registro ${target.label || `+${target.targetUser}`}`);
  const slider = document.createElement('span');
  slider.className = 'switch-slider';
  switchLabel.append(checkbox, slider);
  checkbox.addEventListener('change', () => toggleEnabled(target, checkbox));

  const main = document.createElement('div');
  main.className = 'target-main';

  const title = document.createElement('p');
  title.className = 'target-title';
  if (target.label) {
    const name = document.createElement('span');
    name.textContent = target.label;
    const number = document.createElement('span');
    number.className = 'target-number';
    number.textContent = `+${target.targetUser}`;
    title.append(name, number);
  } else {
    title.textContent = `+${target.targetUser}`;
  }

  const meta = document.createElement('p');
  meta.className = 'target-meta';
  const keyword = document.createElement('strong');
  keyword.textContent = `“${target.keyword}”`;
  meta.append(keyword, ` → ${target.response}`);
  if (target.groupJid) meta.append(` · Grupo: ${groupLabel(target.groupJid)}`);

  main.append(title, meta);
  main.setAttribute('role', 'button');
  main.tabIndex = 0;
  main.title = 'Editar registro';
  main.addEventListener('click', () => openTargetModal(target));
  main.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openTargetModal(target);
    }
  });

  const actions = document.createElement('div');
  actions.className = 'target-actions';
  const deleteBtn = iconButton(ICONS.trash, 'Eliminar registro', 'icon-btn danger');
  deleteBtn.addEventListener('click', () => removeTarget(target));
  actions.appendChild(deleteBtn);

  row.append(switchLabel, main, actions);
  return row;
}

function accountTargetsSection(account) {
  const section = document.createElement('div');
  section.className = 'account-targets';

  const head = document.createElement('div');
  head.className = 'account-targets-head';

  const title = document.createElement('span');
  title.className = 'account-targets-title';
  title.textContent = 'Registros';

  const all = targets.filter((target) => (target.accountId || '') === account.id);
  const active = all.filter((target) => target.enabled).length;
  const count = document.createElement('span');
  count.className = 'badge-count badge-count-sm';
  count.textContent = `${active} activos / ${all.length}`;

  head.append(title, count);

  const list = document.createElement('div');
  list.className = 'account-target-list';
  all.forEach((target) => list.appendChild(targetRow(target)));

  const empty = document.createElement('p');
  empty.className = 'empty-inline';
  empty.textContent = 'Sin registros. Agrega el primero para que este número responda.';
  empty.classList.toggle('hidden', all.length > 0);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'add-row-btn';
  addBtn.textContent = '+ Agregar registro';
  addBtn.addEventListener('click', () => openTargetModal(null, 'single', account.id));

  section.append(head, list, empty, addBtn);
  return section;
}

function renderGlobalTargets() {
  const list = el('globalTargetsList');
  list.innerHTML = '';

  const all = targets.filter((target) => !target.accountId);
  all.forEach((target) => list.appendChild(targetRow(target)));

  const active = all.filter((target) => target.enabled).length;
  el('globalTargetsCount').textContent = `${active} activos / ${all.length}`;
  el('globalTargetsEmpty').classList.toggle('hidden', all.length > 0);

  const activeCount = targets.filter((target) => target.enabled).length;
  const hasActive = activeCount > 0;
  el('stepNumber2').textContent = hasActive ? '✓' : '2';
  el('stepNumber2').classList.toggle('done', hasActive);
}

function renderTargets() {
  renderAccounts();
  renderGlobalTargets();
}

async function refreshTargets() {
  targets = await api('/api/targets');
  renderTargets();
}

function openTargetModal(target = null, mode = 'single', presetAccountId = null) {
  editingId = target?.id ?? null;
  const presetId = target?.accountId ?? presetAccountId ?? '';
  const presetAccount = accounts.find((account) => account.id === presetId);
  el('targetModalTitle').textContent = editingId
    ? 'Editar registro'
    : mode === 'bulk'
      ? 'Agregar varios registros'
      : presetAccount
        ? `Agregar registro para ${presetAccount.label}`
        : 'Agregar registro';
  el('modeBulkBtn').classList.toggle('hidden', Boolean(editingId));
  el('inputLabel').value = target?.label ?? '';
  el('inputNumber').value = target?.targetUser ?? '';
  el('inputGroup').value = target?.groupJid ?? '';
  el('inputKeyword').value = target?.keyword ?? '';
  el('inputResponse').value = target?.response ?? '';
  el('inputBulk').value = '';
  el('bulkReport').classList.add('hidden');
  updateBulkCount();
  fillAccountOptions(presetId);
  showTargetErrors({});
  setModalMode(editingId ? 'single' : mode);
  el('advancedOptions').open = Boolean(editingId && (target?.label || target?.groupJid || target?.accountId));
  el('targetModal').classList.remove('hidden');
  if (modalMode === 'bulk') el('inputBulk').focus();
  else el('inputNumber').focus();
}

function closeTargetModal() {
  el('targetModal').classList.add('hidden');
  editingId = null;
}

function setModalMode(mode) {
  modalMode = mode;
  el('singleFields').classList.toggle('hidden', mode !== 'single');
  el('bulkFields').classList.toggle('hidden', mode !== 'bulk');
  el('advancedLabelField').classList.toggle('hidden', mode === 'bulk');
  el('modeSingleBtn').classList.toggle('modal-tab-active', mode === 'single');
  el('modeBulkBtn').classList.toggle('modal-tab-active', mode === 'bulk');
  el('modeSingleBtn').setAttribute('aria-selected', String(mode === 'single'));
  el('modeBulkBtn').setAttribute('aria-selected', String(mode === 'bulk'));
  el('targetModalSave').textContent =
    mode === 'bulk' ? 'Agregar números' : editingId ? 'Guardar cambios' : 'Guardar registro';
}

// Convierte cada línea en un número con etiqueta opcional: "584241234567, Cliente Ana".
function parseBulkLines(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[,;\t]/).map((part) => part.trim()).filter(Boolean);
      const targetUser = (parts.shift() ?? '').replace(/\D/g, '');
      const label = parts.join(' ').trim().slice(0, 60);
      return { targetUser, label };
    });
}

function updateBulkCount() {
  const count = parseBulkLines(el('inputBulk').value).length;
  el('bulkCount').textContent = count > 0 ? `${count} número(s) detectado(s).` : 'Escribe al menos un número.';
}

function renderBulkReport(result) {
  const box = el('bulkReport');
  box.innerHTML = '';

  const summary = document.createElement('p');
  summary.className = 'bulk-report-title';
  summary.textContent = `${result.created.length} agregado(s) · ${result.skipped.length} omitido(s)`;
  box.appendChild(summary);

  if (result.skipped.length > 0) {
    const list = document.createElement('ul');
    for (const item of result.skipped) {
      const li = document.createElement('li');
      li.textContent = `+${item.input || '—'}: ${item.reason}`;
      list.appendChild(li);
    }
    box.appendChild(list);
  }

  box.classList.remove('hidden');
}

function buildTargetPayload() {
  return {
    label: el('inputLabel').value.trim(),
    targetUser: el('inputNumber').value.replace(/\D/g, ''),
    groupJid: el('inputGroup').value.trim().toLowerCase(),
    keyword: el('inputKeyword').value.trim(),
    response: el('inputResponse').value.trim(),
    accountId: el('inputAccount').value,
  };
}

function showTargetErrors(errors) {
  for (const field of TARGET_FIELDS) {
    const errorBox = el(`error${field[0].toUpperCase()}${field.slice(1)}`);
    const input = el(`input${field[0].toUpperCase()}${field.slice(1)}`);
    if (errors[field]) {
      errorBox.textContent = errors[field];
      errorBox.classList.remove('hidden');
      input.classList.add('invalid');
    } else {
      errorBox.classList.add('hidden');
      input.classList.remove('invalid');
    }
  }
}

function targetFormErrors(values) {
  const errors = {};
  if (!values.targetUser) {
    errors.number = 'Introduce el número de WhatsApp.';
  } else if (values.targetUser.length < 8 || values.targetUser.length > 15) {
    errors.number = 'Debe tener entre 8 y 15 dígitos, incluyendo el código de país.';
  }
  if (!values.keyword) errors.keyword = 'La palabra clave no puede estar vacía.';
  if (!values.response) errors.response = 'La respuesta no puede estar vacía.';
  if (values.groupJid && !/^[\d-]+@g\.us$/i.test(values.groupJid)) {
    errors.group = 'Formato no válido. Ejemplo: 1234567890-123456@g.us';
  }
  return errors;
}

function mapTargetServerErrors(details) {
  const errors = {};
  for (const detail of details) {
    const text = String(detail).toLowerCase();
    if (text.includes('número')) errors.number = detail;
    else if (text.includes('palabra clave')) errors.keyword = detail;
    else if (text.includes('respuesta')) errors.response = detail;
    else if (text.includes('grupo') || text.includes('jid')) errors.group = detail;
    else toast('error', 'No se pudo guardar', detail);
  }
  showTargetErrors(errors);
}

async function saveTarget() {
  const payload = buildTargetPayload();
  const errors = targetFormErrors(payload);
  showTargetErrors(errors);
  if (Object.keys(errors).length > 0) {
    toast('error', 'Revisa el formulario', 'Hay campos con errores.');
    return;
  }

  await withLoading(el('targetModalSave'), async () => {
    try {
      const saved = editingId
        ? await api(`/api/targets/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await api('/api/targets', { method: 'POST', body: JSON.stringify(payload) });

      targets = editingId ? targets.map((item) => (item.id === saved.id ? saved : item)) : [...targets, saved];
      renderTargets();
      closeTargetModal();
      toast(
        'success',
        editingId ? 'Registro actualizado' : 'Número registrado',
        `${saved.label || `+${saved.targetUser}`} responderá a “${saved.keyword}”.`,
      );
    } catch (error) {
      toast('error', 'No se pudo guardar', error.message);
      if (error.details?.length) mapTargetServerErrors(error.details);
    }
  });
}

async function saveBulk() {
  const entries = parseBulkLines(el('inputBulk').value);
  const shared = {
    keyword: el('inputKeyword').value.trim(),
    response: el('inputResponse').value.trim(),
    groupJid: el('inputGroup').value.trim().toLowerCase(),
    label: '',
    accountId: el('inputAccount').value,
  };

  const errors = {};
  if (entries.length === 0) errors.bulk = 'Agrega al menos un número, uno por línea.';
  if (!shared.keyword) errors.keyword = 'La palabra clave no puede estar vacía.';
  if (!shared.response) errors.response = 'La respuesta no puede estar vacía.';
  if (shared.groupJid && !/^[\d-]+@g\.us$/i.test(shared.groupJid)) {
    errors.group = 'Formato no válido. Ejemplo: 1234567890-123456@g.us';
  }
  showTargetErrors(errors);
  if (Object.keys(errors).length > 0) {
    toast('error', 'Revisa el formulario', 'Hay campos con errores.');
    return;
  }

  await withLoading(el('targetModalSave'), async () => {
    try {
      const result = await api('/api/targets/bulk', {
        method: 'POST',
        body: JSON.stringify({ entries, ...shared }),
      });

      targets = [...targets, ...result.created];
      renderTargets();
      renderBulkReport(result);

      if (result.created.length > 0 && result.skipped.length === 0) {
        closeTargetModal();
        toast('success', `${result.created.length} número(s) agregado(s)`, 'Todos quedaron activos y listos para responder.');
      } else if (result.created.length > 0) {
        toast('warn', `${result.created.length} agregado(s), ${result.skipped.length} omitido(s)`, 'Revisa el detalle en la ventana.');
      } else {
        toast('error', 'No se agregó ningún número', 'Todos los registros fueron omitidos.');
      }
    } catch (error) {
      toast('error', 'No se pudo completar la carga', error.message);
      if (error.details?.length) mapTargetServerErrors(error.details);
    }
  });
}

async function toggleEnabled(target, checkbox) {
  const previous = target.enabled;
  checkbox.disabled = true;
  try {
    const saved = await api(`/api/targets/${target.id}/enabled`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: checkbox.checked }),
    });
    targets = targets.map((item) => (item.id === saved.id ? saved : item));
    renderTargets();
    toast('info', saved.enabled ? 'Registro activado' : 'Registro desactivado', saved.label || `+${saved.targetUser}`);
  } catch (error) {
    checkbox.checked = previous;
    checkbox.disabled = false;
    toast('error', 'No se pudo cambiar el estado', error.message);
  }
}

async function removeTarget(target) {
  const confirmed = await confirmDialog({
    title: 'Eliminar registro',
    message: `Se eliminará ${target.label ? `“${target.label}” (+${target.targetUser})` : `+${target.targetUser}`}. El bot dejará de responder por este registro.`,
    confirmText: 'Sí, eliminar',
    danger: true,
  });
  if (!confirmed) return;

  try {
    await api(`/api/targets/${target.id}`, { method: 'DELETE' });
    targets = targets.filter((item) => item.id !== target.id);
    renderTargets();
    toast('warn', 'Registro eliminado', target.label || `+${target.targetUser}`);
  } catch (error) {
    toast('error', 'No se pudo eliminar', error.message);
  }
}

el('targetForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (modalMode === 'bulk' && !editingId) saveBulk();
  else saveTarget();
});

el('targetModalCancel').addEventListener('click', closeTargetModal);
el('targetModal').addEventListener('click', (event) => {
  if (event.target === el('targetModal')) closeTargetModal();
});

el('modeSingleBtn').addEventListener('click', () => setModalMode('single'));
el('modeBulkBtn').addEventListener('click', () => {
  setModalMode('bulk');
  el('inputBulk').focus();
});

el('inputBulk').addEventListener('input', updateBulkCount);

el('addTargetBtn').addEventListener('click', () => openTargetModal(null, 'single'));

for (const field of TARGET_FIELDS) {
  const input = el(`input${field[0].toUpperCase()}${field.slice(1)}`);
  input.addEventListener('input', () => {
    el(`error${field[0].toUpperCase()}${field.slice(1)}`).classList.add('hidden');
    input.classList.remove('invalid');
  });
}

el('inputNumber').addEventListener('blur', () => {
  const digits = el('inputNumber').value.replace(/\D/g, '');
  if (digits) el('inputNumber').value = digits;
});

el('inputGroup').addEventListener('blur', () => {
  const value = el('inputGroup').value.trim().toLowerCase();
  if (/^\d+$/.test(value)) el('inputGroup').value = `${value}@g.us`;
});

async function loadGroups() {
  await withLoading(el('loadGroupsBtn'), async () => {
    try {
      const accountId = el('inputAccount').value;
      const url = accountId ? `/api/groups?accountId=${encodeURIComponent(accountId)}` : '/api/groups';
      const groups = await api(url);
      groupsCache = groups;
      const dataList = el('groupOptions');
      dataList.innerHTML = '';
      for (const group of groups) {
        const option = document.createElement('option');
        option.value = group.jid;
        option.label = group.subject;
        dataList.appendChild(option);
      }
      renderTargets();
      if (groups.length === 0) {
        toast('info', 'No hay grupos disponibles', 'La cuenta no participa en ningún grupo.');
      } else {
        toast('success', `${groups.length} grupo(s) cargados`, 'Escribe en el campo de grupo para elegir uno.');
      }
    } catch (error) {
      toast('error', 'No se pudieron cargar los grupos', error.message);
    }
  });
}

el('loadGroupsBtn').addEventListener('click', loadGroups);

/* ---- Logs ---- */
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('es-ES', { hour12: false });
}

function logEntryNode(entry) {
  const item = document.createElement('li');
  item.className = `log log-${entry.level}`;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = formatTime(entry.ts);

  const text = document.createElement('span');
  text.className = 'log-msg';
  text.textContent = entry.message;

  item.append(time, text);
  return item;
}

function scrollLogsToBottom() {
  const list = el('logList');
  list.scrollTop = list.scrollHeight;
}

function nearBottom() {
  const list = el('logList');
  return list.scrollHeight - list.scrollTop - list.clientHeight < 40;
}

function updateScrollButton() {
  el('scrollBottomBtn').classList.toggle('hidden', autoScroll);
}

function renderLogs() {
  const list = el('logList');
  list.innerHTML = '';
  const visible = logs.filter((entry) => logFilter === 'all' || entry.level === logFilter);
  visible.forEach((entry) => list.appendChild(logEntryNode(entry)));

  const empty = el('logEmpty');
  empty.textContent = logs.length === 0 ? 'Aún no hay eventos.' : 'No hay eventos con este filtro.';
  empty.classList.toggle('hidden', visible.length > 0);

  if (autoScroll) scrollLogsToBottom();
  updateScrollButton();
}

function appendLog(entry) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();

  if (logFilter === 'all' || entry.level === logFilter) {
    const list = el('logList');
    list.appendChild(logEntryNode(entry));
    while (list.children.length > MAX_LOGS) list.removeChild(list.firstChild);
    el('logEmpty').classList.add('hidden');
  }

  if (autoScroll) scrollLogsToBottom();
  updateScrollButton();
}

el('logList').addEventListener('scroll', () => {
  autoScroll = nearBottom();
  updateScrollButton();
});

el('scrollBottomBtn').addEventListener('click', () => {
  autoScroll = true;
  scrollLogsToBottom();
  updateScrollButton();
});

el('logFilters').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  logFilter = chip.dataset.level;
  el('logFilters').querySelectorAll('.chip').forEach((node) => node.classList.toggle('chip-active', node === chip));
  renderLogs();
});

el('copyLogsBtn').addEventListener('click', async () => {
  if (logs.length === 0) {
    toast('info', 'No hay eventos para copiar');
    return;
  }
  const text = logs.map((entry) => `${formatTime(entry.ts)} [${entry.level.toUpperCase()}] ${entry.message}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('success', 'Eventos copiados al portapapeles');
  } catch {
    toast('error', 'No se pudo copiar', 'El navegador bloqueó el acceso al portapapeles.');
  }
});

el('clearLogsBtn').addEventListener('click', () => {
  logs = [];
  renderLogs();
  toast('info', 'Panel de eventos limpio');
});

/* ---- Ajustes de respuesta ---- */
function applySettings(settings) {
  const humanize = Boolean(settings.humanize);
  el('humanizeToggle').checked = humanize;
  el('humanizeHint').textContent = humanize
    ? 'Humanizado: espera de 5 a 15 s, simula escritura de 2 a 5 s y luego responde.'
    : 'Respuesta inmediata: contesta en cuanto detecta la palabra clave.';
}

el('humanizeToggle').addEventListener('change', async (event) => {
  const toggle = event.target;
  toggle.disabled = true;
  try {
    const settings = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ humanize: toggle.checked }),
    });
    applySettings(settings);
    toast(
      'info',
      settings.humanize ? 'Modo humano activado' : 'Respuesta inmediata activada',
      settings.humanize
        ? 'Las respuestas esperarán y simularán escritura.'
        : 'El bot contestará al instante.',
    );
  } catch (error) {
    toggle.checked = !toggle.checked;
    toast('error', 'No se pudo cambiar el ajuste', error.message);
  } finally {
    toggle.disabled = false;
  }
});

/* ---- Sesión y atajos ---- */
el('logoutPanelBtn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } finally {
    window.location.href = '/login';
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (confirmResolver) confirmResolver(false);
    else if (!el('accountModal').classList.contains('hidden')) closeAccountModal();
    else if (!el('targetModal').classList.contains('hidden')) closeTargetModal();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (!el('accountModal').classList.contains('hidden')) el('accountForm').requestSubmit();
    else if (!el('targetModal').classList.contains('hidden')) el('targetForm').requestSubmit();
  }
});

/* ---- Socket.IO ---- */
socket.on('accounts', (list) => {
  accounts = list;
  renderAccounts();
  renderTargets();
});
socket.on('logs', (entries) => {
  logs = entries.slice(-MAX_LOGS);
  renderLogs();
});
socket.on('log', appendLog);

/* ---- Arranque ---- */
async function init() {
  try {
    const session = await api('/api/session');
    if (!session.authenticated) {
      window.location.href = '/login';
      return;
    }
    const [accountList, targetList, settings] = await Promise.all([
      api('/api/accounts'),
      api('/api/targets'),
      api('/api/settings'),
    ]);
    accounts = accountList;
    targets = targetList;
    applySettings(settings);
    renderAccounts();
    renderTargets();
  } catch {
    /* api() ya redirige si la sesión expiró */
  }
}

init();
