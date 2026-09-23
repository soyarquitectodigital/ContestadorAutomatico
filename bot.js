import { rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState } from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { getSettings, getTargets } from './lib/config.js';
import { accountAuthFolder, getAccount, getAccounts } from './lib/accounts.js';
import { addLog } from './lib/logger.js';
import { containsAnyKeyword, containsKeyword, describeAuthor, evaluateMessage, extractText, matchesTargetUser } from './lib/filters.js';

export const botEvents = new EventEmitter();

// ==== Parámetros de humanización / anti-baneo ====
const INITIAL_DELAY_MIN_MS = 5000; // retraso inicial mínimo antes de responder
const INITIAL_DELAY_MAX_MS = 15000; // retraso inicial máximo antes de responder
const TYPING_DELAY_MIN_MS = 2000; // duración mínima del estado "escribiendo..."
const TYPING_DELAY_MAX_MS = 5000; // duración máxima del estado "escribiendo..."
const MIN_REPLY_INTERVAL_MS = 15000; // intervalo mínimo entre respuestas por registro
const MAX_MESSAGE_AGE_MS = 60000; // ignora mensajes con más de 1 minuto de antigüedad
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;
const BUSY_STATUSES = ['connecting', 'qr', 'connected', 'reconnecting'];

// Una sesión por cuenta de WhatsApp.
const sessions = new Map();
// Evita que dos cuentas respondan el mismo mensaje cuando el registro es "cualquier cuenta".
const repliedGlobally = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function getSession(accountId) {
  if (!sessions.has(accountId)) {
    sessions.set(accountId, {
      sock: null,
      status: 'disconnected',
      detail: '',
      qr: null,
      startedByUser: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      processedIds: new Set(),
      busyChats: new Set(),
      lastReplyByTarget: new Map(),
    });
  }
  return sessions.get(accountId);
}

function publicState(account) {
  const session = sessions.get(account.id);
  return {
    id: account.id,
    label: account.label,
    status: session?.status ?? 'disconnected',
    detail: session?.detail ?? 'Sin conectar',
    qr: session?.qr ?? null,
    connected: (session?.status ?? 'disconnected') === 'connected',
  };
}

export function getAccountStates() {
  return getAccounts().map(publicState);
}

export function getAggregateState() {
  const states = getAccountStates();
  const connectedCount = states.filter((state) => state.connected).length;
  let status = 'disconnected';
  if (states.some((state) => state.status === 'qr')) status = 'qr';
  else if (states.some((state) => ['connecting', 'reconnecting'].includes(state.status))) status = 'connecting';
  else if (connectedCount > 0) status = 'connected';

  const detail =
    states.length === 0
      ? 'Sin números de WhatsApp vinculados'
      : `${connectedCount} de ${states.length} número(s) conectado(s)`;

  return { status: states.length === 0 ? 'disconnected' : status, detail, connectedCount, total: states.length };
}

function emitAccounts() {
  botEvents.emit('accounts', getAccountStates());
}

function setStatus(account, status, detail = '') {
  const session = getSession(account.id);
  session.status = status;
  session.detail = detail;
  if (status !== 'qr') session.qr = null;
  emitAccounts();
}

async function clearAuthFolder(accountId) {
  await rm(accountAuthFolder(accountId), { recursive: true, force: true });
}

/* ---- Conexión por cuenta ---- */

export async function startAccount(id) {
  const account = getAccount(id);
  if (!account) throw new Error('Número de WhatsApp no encontrado.');

  const session = getSession(id);
  if (BUSY_STATUSES.includes(session.status)) return publicState(account);

  session.startedByUser = true;
  session.reconnectAttempts = 0;
  try {
    await connect(account);
  } catch (error) {
    setStatus(account, 'error', `No se pudo iniciar: ${error?.message ?? error}`);
    addLog('error', `[${account.label}] No se pudo iniciar: ${error?.message ?? error}`);
  }
  return publicState(getAccount(id) ?? account);
}

async function connect(account) {
  const session = getSession(account.id);
  setStatus(account, 'connecting', 'Iniciando conexión con WhatsApp...');
  addLog('info', `[${account.label}] Iniciando conexión con WhatsApp...`);

  const { state: authState, saveCreds } = await useMultiFileAuthState(accountAuthFolder(account.id));

  const sock = makeWASocket({
    auth: authState,
    // Logger de Baileys en silencio: el panel tiene su propio registro de eventos.
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    // false => el teléfono sigue recibiendo notificaciones (menos sospechoso para WhatsApp).
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });
  session.sock = sock;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    handleConnectionUpdate(account.id, update).catch((error) => {
      addLog('error', `[${account.label}] Error de conexión: ${error?.message ?? error}`);
    });
  });
  sock.ev.on('messages.upsert', (event) => {
    handleMessages(account.id, event).catch((error) => {
      addLog('error', `[${account.label}] Error procesando mensajes: ${error?.message ?? error}`);
    });
  });
}

async function handleConnectionUpdate(accountId, update) {
  const account = getAccount(accountId);
  if (!account) return; // La cuenta se eliminó mientras estaba conectada.
  const session = getSession(accountId);
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    session.qr = await QRCode.toDataURL(qr, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
    setStatus(account, 'qr', 'Escanea el código QR desde WhatsApp');
    addLog('info', `[${account.label}] Código QR generado. Escanéalo desde WhatsApp → Dispositivos vinculados.`);
  }

  if (connection === 'connecting' && session.status !== 'qr') {
    setStatus(account, 'connecting', 'Conectando...');
  }

  if (connection === 'open') {
    session.reconnectAttempts = 0;
    setStatus(account, 'connected', 'Conectado a WhatsApp');
    addLog('success', `[${account.label}] WhatsApp conectado correctamente.`);
  }

  if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;

    if (statusCode === DisconnectReason.loggedOut) {
      session.startedByUser = false;
      await clearAuthFolder(accountId);
      setStatus(account, 'logged_out', 'Sesión cerrada desde el teléfono');
      addLog('error', `[${account.label}] La sesión se cerró desde el teléfono. Pulsa "Vincular" para escanear un nuevo QR.`);
      return;
    }

    if (session.startedByUser) {
      addLog('warn', `[${account.label}] Conexión cerrada (código ${statusCode ?? 'desconocido'}).`);
      scheduleReconnect(accountId);
    } else {
      setStatus(account, 'disconnected', 'Detenido por el usuario');
    }
  }
}

function scheduleReconnect(accountId) {
  const account = getAccount(accountId);
  if (!account) return;
  const session = getSession(accountId);
  if (!session.startedByUser || session.reconnectTimer) return;

  session.reconnectAttempts += 1;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * session.reconnectAttempts);
  setStatus(account, 'reconnecting', `Reintentando en ${Math.round(delay / 1000)}s (intento ${session.reconnectAttempts})`);
  addLog('warn', `[${account.label}] Reintentando conexión en ${Math.round(delay / 1000)}s...`);

  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    const current = getAccount(accountId);
    if (!current) return;
    connect(current).catch((error) => {
      addLog('error', `[${current.label}] Fallo al reconectar: ${error?.message ?? error}`);
      scheduleReconnect(accountId);
    });
  }, delay);
}

export async function stopAccount(id) {
  const account = getAccount(id);
  const session = getSession(id);
  session.startedByUser = false;

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  if (session.sock) {
    try {
      session.sock.ev.removeAllListeners('connection.update');
      session.sock.ev.removeAllListeners('messages.upsert');
      session.sock.end(new Error('Cuenta detenida por el usuario'));
    } catch {
      // El socket ya estaba cerrado.
    }
    session.sock = null;
  }

  if (account) setStatus(account, 'disconnected', 'Detenido por el usuario');
  else emitAccounts();
  addLog('warn', `[${account?.label ?? 'Cuenta'}] Detenida. La sesión de WhatsApp se conserva.`);
}

export async function logoutAccount(id) {
  const account = getAccount(id);
  const session = getSession(id);
  session.startedByUser = false;

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  if (session.sock) {
    try {
      await session.sock.logout();
    } catch {
      try {
        session.sock.end();
      } catch {
        // Ignorar.
      }
    }
    session.sock = null;
  }

  await clearAuthFolder(id);
  if (account) setStatus(account, 'logged_out', 'Sesión eliminada');
  else emitAccounts();
  addLog('warn', `[${account?.label ?? 'Cuenta'}] Sesión eliminada. Escanea un nuevo QR para reconectar.`);
}

// Al eliminar una cuenta: detener, borrar su sesión y liberar la memoria.
export async function removeAccountSession(id) {
  const session = getSession(id);
  session.startedByUser = false;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  if (session.sock) {
    try {
      session.sock.ev.removeAllListeners('connection.update');
      session.sock.ev.removeAllListeners('messages.upsert');
      session.sock.end(new Error('Cuenta eliminada'));
    } catch {
      // Ignorar.
    }
    session.sock = null;
  }
  await clearAuthFolder(id);
  sessions.delete(id);
  emitAccounts();
}

export async function startAllAccounts() {
  for (const account of getAccounts()) {
    await startAccount(account.id);
  }
  return getAccountStates();
}

export async function stopAllAccounts() {
  for (const account of getAccounts()) {
    await stopAccount(account.id);
  }
  return getAccountStates();
}

export async function getGroups(accountId) {
  let account = accountId ? getAccount(accountId) : null;
  if (!account) {
    account = getAccounts().find((item) => sessions.get(item.id)?.status === 'connected') ?? null;
  }
  const session = account ? sessions.get(account.id) : null;
  if (!account || session?.status !== 'connected' || !session.sock) {
    throw new Error('Esa cuenta no está conectada a WhatsApp.');
  }
  const groups = await session.sock.groupFetchAllParticipating();
  return Object.values(groups)
    .map((group) => ({ jid: group.id, subject: group.subject || '(sin nombre)', accountId: account.id }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

/* ---- Mensajes ---- */

async function handleMessages(accountId, { messages, type }) {
  const account = getAccount(accountId);
  if (!account) return;

  // Solo mensajes en vivo (se descarta el historial sincronizado).
  if (type !== 'notify') return;

  // Registros de esta cuenta: los asignados a ella y los de "cualquier cuenta".
  const targets = getTargets().filter((target) => !target.accountId || target.accountId === accountId);
  if (targets.length === 0) return;

  const session = getSession(accountId);
  const { humanize } = getSettings();

  for (const message of messages) {
    if (!message?.key?.id) continue;

    // Evita responder dos veces el mismo mensaje (reintentos / duplicados).
    if (session.processedIds.has(message.key.id)) continue;
    session.processedIds.add(message.key.id);
    if (session.processedIds.size > 1000) session.processedIds.clear();

    // Anti-baneo: nunca responder a mensajes antiguos (historial).
    const timestampMs = Number(message.messageTimestamp) * 1000;
    if (timestampMs && Date.now() - timestampMs > MAX_MESSAGE_AGE_MS) continue;

    const jid = message.key.remoteJid;
    const author = describeAuthor(message.key);
    const result = evaluateMessage(message, targets);

    if (!result.pass) {
      const text = extractText(message.message);
      const authorTargets = targets.filter((target) => matchesTargetUser(message.key, target.targetUser));

      if (result.reason === 'usuario-no-objetivo' && text) {
        // El autor tiene registros, pero en otra cuenta de WhatsApp.
        const matchesElsewhere = getTargets().some(
          (target) => matchesTargetUser(message.key, target.targetUser) && containsKeyword(text, target.keyword),
        );
        if (matchesElsewhere) {
          addLog('warn', `[${account.label}] ${author} tiene registros en otra cuenta de WhatsApp; este número no responderá. Se ignora.`);
        } else if (containsAnyKeyword(text, targets)) {
          addLog('warn', `[${account.label}] Mensaje con palabra clave de un número no registrado (${author}) en ${jid}. Se ignora.`);
        }
      } else if (result.reason === 'sin-palabra-clave' && authorTargets.length > 0) {
        addLog('info', `[${account.label}] Bot ignorando mensaje de ${author}: no contiene la palabra clave.`);
      } else if (result.reason === 'otro-grupo') {
        addLog('info', `[${account.label}] Palabra clave de ${author} ignorada: el grupo no coincide con su registro.`);
      } else if (result.reason === 'registro-desactivado') {
        addLog('warn', `[${account.label}] Coincidencia con ${author}, pero su registro está desactivado.`);
      }
      continue;
    }

    const { target } = result;
    const who = target.label ? `${target.label} (${author})` : author;

    // Registro "cualquier cuenta": evita que dos cuentas respondan el mismo mensaje.
    if (!target.accountId) {
      const globalKey = `${target.id}:${message.key.id}`;
      if (repliedGlobally.has(globalKey)) {
        addLog('warn', `[${account.label}] Otra cuenta ya respondió este mensaje (registro para ${who}). Se omite.`);
        continue;
      }
      repliedGlobally.set(globalKey, Date.now());
      if (repliedGlobally.size > 1000) repliedGlobally.clear();
    }

    addLog('success', `[${account.label}] Mensaje detectado de ${who} con la palabra clave.`);

    // Anti-baneo: no solapar respuestas en el mismo chat.
    if (session.busyChats.has(jid)) {
      addLog('warn', `[${account.label}] Ya hay una respuesta en curso en este chat. Se omite este mensaje.`);
      continue;
    }

    // El límite de frecuencia solo aplica en Modo humano.
    // Con respuesta inmediata (por defecto) no se limita ningún mensaje.
    if (humanize) {
      const lastReplyAt = session.lastReplyByTarget.get(target.id) ?? 0;
      if (Date.now() - lastReplyAt < MIN_REPLY_INTERVAL_MS) {
        addLog('warn', `[${account.label}] Modo humano: se omite una respuesta seguida al mismo registro (límite de 15 s).`);
        continue;
      }
    }

    session.busyChats.add(jid);
    session.lastReplyByTarget.set(target.id, Date.now());
    try {
      await sendReply(session.sock, jid, target.response, message);
      addLog('success', `[${account.label}] Respuesta enviada a ${who} citando el mensaje original.`);
    } catch (error) {
      addLog('error', `[${account.label}] No se pudo enviar la respuesta: ${error?.message ?? error}`);
    } finally {
      session.busyChats.delete(jid);
    }
  }
}

// Envío de la respuesta.
// Modo humano desactivado (por defecto): responde al instante.
// Modo humano activado en Ajustes: ejecuta la secuencia anti-baneo completa.
async function sendReply(sock, jid, responseText, quotedMessage) {
  const { humanize } = getSettings();

  if (!humanize) {
    await sock.sendMessage(jid, { text: responseText }, { quoted: quotedMessage });
    return;
  }

  // ==== Secuencia de humanización anti-baneo (orden obligatorio) ====
  // 1) Retraso inicial aleatorio de 5 a 15 segundos, como una persona que aún no responde.
  const initialDelay = randomBetween(INITIAL_DELAY_MIN_MS, INITIAL_DELAY_MAX_MS);
  addLog('info', `Esperando ${(initialDelay / 1000).toFixed(1)}s antes de responder (humanización).`);
  await sleep(initialDelay);

  // 2) Mostrar "escribiendo..." en el chat.
  await sock.sendPresenceUpdate('composing', jid);

  // 3) Mantener la escritura entre 2 y 5 segundos.
  const typingDelay = randomBetween(TYPING_DELAY_MIN_MS, TYPING_DELAY_MAX_MS);
  addLog('info', `Simulando escritura durante ${(typingDelay / 1000).toFixed(1)}s.`);
  await sleep(typingDelay);

  // 4) Detener "escribiendo...".
  await sock.sendPresenceUpdate('paused', jid);

  // 5) Enviar la respuesta citando el mensaje original (quoted obligatorio).
  await sock.sendMessage(jid, { text: responseText }, { quoted: quotedMessage });
}
