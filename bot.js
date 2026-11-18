import { rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState } from 'baileys';
import NodeCache from '@cacheable/node-cache';
import pino from 'pino';
import QRCode from 'qrcode';
import { getSettings, getTargets } from './lib/config.js';
import { accountAuthFolder, getAccount, getAccounts } from './lib/accounts.js';
import { usingDb } from './lib/db.js';
import { clearDbAuthState, useDbAuthState } from './lib/auth-state.js';
import { addLog } from './lib/logger.js';
import { recordAck, recordMessageEvent, recordSystemEvent } from './lib/metrics.js';
import { containsAnyKeyword, matchesAnyKeyword, describeAuthor, evaluateMessage, extractText, matchesTargetUser, targetKeywords } from './lib/filters.js';
import { createGroupMetadataCache } from './lib/group-cache.js';
import { createChatQueues, QueueFullError } from './lib/chat-queue.js';
import { groupsToPrewarm, DEFAULT_MAX_PREWARM_GROUPS } from './lib/prewarm.js';

export const botEvents = new EventEmitter();

// ==== Parámetros de humanización / anti-baneo ====
const INITIAL_DELAY_MIN_MS = 5000; // retraso inicial mínimo antes de responder
const INITIAL_DELAY_MAX_MS = 15000; // retraso inicial máximo antes de responder
const TYPING_DELAY_MIN_MS = 2000; // duración mínima del estado "escribiendo..."
const TYPING_DELAY_MAX_MS = 5000; // duración máxima del estado "escribiendo..."
const MIN_REPLY_INTERVAL_MS = 15000; // intervalo mínimo entre respuestas por registro
const MAX_MESSAGE_AGE_MS = 120000; // ignora mensajes con más de 2 minutos de antigüedad
// Cache de dispositivos por cuenta (evita consultas USync en cada envío).
// Baileys invalida la entrada cuando WhatsApp notifica cambios de dispositivos,
// así que un TTL largo no deja la lista obsoleta.
const USER_DEVICES_TTL_SECONDS = 12 * 60 * 60;
// Refresco en segundo plano de los grupos con registros activos. Con los cachés
// calientes es casi gratis (todo sale de memoria); si algo venció, se refresca
// antes de que llegue una carga, no durante la carrera.
const PREWARM_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;
const ACK_LABELS = { 2: 'servidor', 3: 'entregado', 4: 'leído' };
const BUSY_STATUSES = ['connecting', 'qr', 'connected', 'reconnecting'];

// Una sesión por cuenta de WhatsApp.
const sessions = new Map();

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
      chats: createChatQueues(),
      groupMetadataCache: createGroupMetadataCache(),
      userDevicesCache: new NodeCache({ stdTTL: USER_DEVICES_TTL_SECONDS, useClones: false }),
      lastReplyByTarget: new Map(),
      prewarming: false,
      prewarmTimer: null,
      sentMessages: new Map(),
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
  if (usingDb()) {
    await clearDbAuthState(accountId);
    return;
  }
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

// Metadatos de grupo con recuperación automática: si el caché no tiene el
// grupo (o venció), se consulta una vez a WhatsApp y se guarda. Antes Baileys
// consultaba por su cuenta en cada envío y el resultado se perdía, así que
// después del TTL todas las respuestas pagaban la consulta otra vez.
async function loadGroupMetadata(session, jid) {
  if (typeof jid !== 'string' || !jid.endsWith('@g.us')) return undefined;

  const sock = session.sock;
  if (!sock || typeof sock.groupMetadata !== 'function') return undefined;

  try {
    return await session.groupMetadataCache.getOrFetch(jid, () => sock.groupMetadata(jid));
  } catch (error) {
    addLog('warn', `No se pudieron obtener los metadatos de ${jid}: ${error?.message ?? error}`);
    return undefined;
  }
}

async function connect(account) {
  const session = getSession(account.id);
  setStatus(account, 'connecting', 'Iniciando conexión con WhatsApp...');
  addLog('info', `[${account.label}] Iniciando conexión con WhatsApp...`);

  // Sesión de WhatsApp: en la nube (Turso) si está configurada, o en disco.
  const { state: authState, saveCreds } = usingDb()
    ? await useDbAuthState(account.id)
    : await useMultiFileAuthState(accountAuthFolder(account.id));

  const sock = makeWASocket({
    auth: authState,
    // Logger de Baileys en silencio: el panel tiene su propio registro de eventos.
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    // false => el teléfono sigue recibiendo notificaciones (menos sospechoso para WhatsApp).
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    // Metadatos de grupo desde memoria y, si faltan, se recuperan y se guardan.
    cachedGroupMetadata: async (jid) => loadGroupMetadata(session, jid),
    // Lista de dispositivos de participantes con TTL de 12 h (menos consultas USync).
    userDevicesCache: session.userDevicesCache,
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
  // Confirmaciones reales de WhatsApp: permite separar "el bot envió" de
  // "WhatsApp entregó". Antes sendMessage resolvía al escribir el socket y no
  // había forma de saber cuánto tardó realmente en llegar al grupo.
  sock.ev.on('messages.update', (updates = []) => {
    for (const { key, update } of updates) {
      if (!key?.id || !update || typeof update.status !== 'number') continue;
      const sent = session.sentMessages.get(key.id);
      if (!sent) continue;

      const ackMs = Date.now() - sent.at;
      recordAck({ accountId: account.id, messageId: key.id, status: update.status, ackMs });

      if (update.status === 0) {
        session.sentMessages.delete(key.id);
        addLog('warn', `[${account.label}] WhatsApp rechazó la respuesta (${ackMs} ms).`);
        continue;
      }

      const label = ACK_LABELS[update.status];
      if (!label) continue;
      // Se conserva la entrada hasta el acuse final para que la métrica quede
      // con el estado más avanzado (servidor → entregado → leído).
      if (update.status >= 4) session.sentMessages.delete(key.id);
      if (update.status === 2 || update.status === 4) {
        addLog('info', `[${account.label}] ACK ${label} en ${ackMs} ms.`);
      }
    }
  });
  // Mantiene fresco el cache de metadatos de grupo sin consultarlo en cada envío.
  sock.ev.on('groups.upsert', (metadatas = []) => {
    for (const metadata of metadatas) session.groupMetadataCache.set(metadata);
  });
  sock.ev.on('groups.update', (metadatas = []) => {
    session.groupMetadataCache.merge(metadatas);
  });
  sock.ev.on('group-participants.update', ({ id } = {}) => {
    session.groupMetadataCache.invalidate(id);
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
    recordSystemEvent({ accountId: account.id, accountLabel: account.label, event: 'qr', detail: 'Código QR generado' });
  }

  if (connection === 'connecting' && session.status !== 'qr') {
    setStatus(account, 'connecting', 'Conectando...');
  }

  if (connection === 'open') {
    session.reconnectAttempts = 0;
    setStatus(account, 'connected', 'Conectado a WhatsApp');
    addLog('success', `[${account.label}] WhatsApp conectado correctamente.`);
    recordSystemEvent({ accountId: account.id, accountLabel: account.label, event: 'connected' });
    // Precalienta el cache de grupos en una sola consulta (best-effort).
    session.groupMetadataCache.clear();
    session.sock?.groupFetchAllParticipating?.().catch(() => {
      // Si falla, el cache se llena con los envíos normales.
    });
    // Precalienta dispositivos y sesiones de los grupos con registros para que
    // la primera respuesta no pague el USync ni el intercambio de prekeys.
    void prewarmAccount(account, session).catch((error) => {
      addLog('warn', `[${account.label}] Precalentamiento inicial falló: ${error?.message ?? error}`);
    });
    // Y mantiene esos cachés calientes mientras la sesión siga conectada.
    startPrewarmTimer(account, session);
  }

  if (connection === 'close') {
    stopPrewarmTimer(session);
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    recordSystemEvent({
      accountId: account.id,
      accountLabel: account.label,
      event: 'closed',
      level: 'warn',
      code: statusCode ?? null,
      detail: lastDisconnect?.error?.message ?? 'Conexión cerrada',
    });

    if (statusCode === DisconnectReason.loggedOut) {
      session.startedByUser = false;
      await clearAuthFolder(accountId);
      setStatus(account, 'logged_out', 'Sesión cerrada desde el teléfono');
      addLog('error', `[${account.label}] La sesión se cerró desde el teléfono. Pulsa "Vincular" para escanear un nuevo QR.`);
      recordSystemEvent({ accountId: account.id, accountLabel: account.label, event: 'logged_out', level: 'error' });
      return;
    }

    if (session.startedByUser) {
      addLog('warn', `[${account.label}] Conexión cerrada (código ${statusCode ?? 'desconocido'}).`);
      scheduleReconnect(accountId);
    } else {
      setStatus(account, 'disconnected', 'Detenido por el usuario');
      recordSystemEvent({ accountId: account.id, accountLabel: account.label, event: 'stopped', level: 'warn' });
    }
  }
}

// Deja listos en memoria dispositivos y sesiones Signal de un grupo, usando los
// métodos internos que Baileys expone. Evita el costo del primer envío.
async function prewarmSingleGroup(account, session, jid) {
  if (typeof session.sock?.getUSyncDevices !== 'function' || typeof session.sock?.assertSessions !== 'function') {
    return 0;
  }

  const meta = await loadGroupMetadata(session, jid);
  const participants = (meta?.participants ?? []).map((participant) => participant.id).filter(Boolean);
  if (participants.length === 0) return 0;

  const deviceList = await session.sock.getUSyncDevices(participants, true, false);
  const deviceJids = deviceList.map((device) => device.jid).filter(Boolean);
  if (deviceJids.length > 0) await session.sock.assertSessions(deviceJids, false);
  return deviceJids.length;
}

// Precalienta los grupos referenciados por los registros de la cuenta.
// `silent` evita llenar el panel con una entrada cada 30 minutos.
async function prewarmAccount(account, session, { silent = false } = {}) {
  if (session.prewarming) return;

  const groups = groupsToPrewarm(getTargets(), account.id, DEFAULT_MAX_PREWARM_GROUPS);
  if (groups.length === 0) return;

  session.prewarming = true;
  const startedAt = Date.now();
  let devices = 0;
  if (!silent) {
    addLog('info', `[${account.label}] Precalentando ${groups.length} grupo(s) para responder más rápido...`);
  }

  try {
    for (const jid of groups) {
      if (session.status !== 'connected' || !session.sock) break;
      try {
        devices += await prewarmSingleGroup(account, session, jid);
      } catch (error) {
        addLog('warn', `[${account.label}] No se pudo precalentar ${jid}: ${error?.message ?? error}`);
      }
    }
  } finally {
    session.prewarming = false;
  }

  if (!silent) {
    addLog(
      'info',
      `[${account.label}] Precalentamiento completado en ${Date.now() - startedAt} ms (${devices} dispositivo(s)).`,
    );
  }

  recordSystemEvent({
    accountId: account.id,
    accountLabel: account.label,
    event: 'prewarm',
    level: 'info',
    durationMs: Date.now() - startedAt,
    detail: `${groups.length} grupo(s), ${devices} dispositivo(s)${silent ? ' (automático)' : ''}`,
  });
}

function stopPrewarmTimer(session) {
  if (!session?.prewarmTimer) return;
  clearInterval(session.prewarmTimer);
  session.prewarmTimer = null;
}

// Mantiene calientes los grupos mientras la sesión está conectada. Si los cachés
// están vigentes, leerlos no genera tráfico; solo se consulta a WhatsApp cuando
// de verdad falta un dato o venció.
function startPrewarmTimer(account, session) {
  stopPrewarmTimer(session);
  session.prewarmTimer = setInterval(() => {
    if (session.status !== 'connected' || !session.sock || session.prewarming) return;
    void prewarmAccount(account, session, { silent: true }).catch((error) => {
      addLog('warn', `[${account.label}] Refresco de caché falló: ${error?.message ?? error}`);
    });
  }, PREWARM_REFRESH_INTERVAL_MS);
  session.prewarmTimer.unref?.();
}

// Precalienta un grupo concreto al guardar o activar un registro con grupo.
export async function prewarmGroup(accountId, groupJid) {
  const account = getAccount(accountId);
  const session = sessions.get(accountId);
  if (!account || !session || !groupJid) return false;
  if (session.status !== 'connected' || !session.sock) return false;

  const startedAt = Date.now();
  try {
    await prewarmSingleGroup(account, session, groupJid);
    addLog('info', `[${account.label}] Grupo ${groupJid} precalentado para respuesta inmediata.`);
    recordSystemEvent({
      accountId: account.id,
      accountLabel: account.label,
      event: 'prewarm_group',
      level: 'info',
      durationMs: Date.now() - startedAt,
      detail: groupJid,
    });
    return true;
  } catch (error) {
    addLog('warn', `[${account.label}] No se pudo precalentar ${groupJid}: ${error?.message ?? error}`);
    recordSystemEvent({
      accountId: account.id,
      accountLabel: account.label,
      event: 'error',
      level: 'warn',
      durationMs: Date.now() - startedAt,
      detail: `No se pudo precalentar ${groupJid}: ${error?.message ?? error}`,
    });
    return false;
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
  recordSystemEvent({
    accountId: account.id,
    accountLabel: account.label,
    event: 'reconnecting',
    level: 'warn',
    durationMs: delay,
    detail: `Intento ${session.reconnectAttempts}`,
  });

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
  stopPrewarmTimer(session);

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
  stopPrewarmTimer(session);

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
  stopPrewarmTimer(session);
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
  session.groupMetadataCache.clear();
  session.userDevicesCache?.close?.();
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

  // Cada cuenta solo evalúa sus propios registros (configuración independiente).
  const targets = getTargets().filter((target) => target.accountId === accountId);
  if (targets.length === 0) return;

  const session = getSession(accountId);
  const { humanize } = getSettings();

  // Chats distintos se atienden en paralelo; cada chat conserva su orden por cola.
  await Promise.allSettled(
    messages.map((message) => processMessage(account, session, message, targets, humanize)),
  );
}

async function processMessage(account, session, message, targets, humanize) {
  if (!message?.key?.id) return;
  const receivedAt = Date.now();
  const messageId = message.key.id;
  const jid = message.key.remoteJid;
  const author = describeAuthor(message.key);

  // Evita responder dos veces el mismo mensaje (reintentos / duplicados).
  if (session.processedIds.has(messageId)) return;
  session.processedIds.add(messageId);
  if (session.processedIds.size > 1000) session.processedIds.clear();

  // Anti-baneo: nunca responder a mensajes antiguos (historial).
  const timestampMs = Number(message.messageTimestamp) * 1000;
  const inboundMs = timestampMs ? Math.max(0, receivedAt - timestampMs) : null;
  const baseEvent = {
    ts: receivedAt,
    accountId: account.id,
    accountLabel: account.label,
    sourceMessageId: messageId,
    chatJid: jid,
    inboundMs,
  };

  if (timestampMs && Date.now() - timestampMs > MAX_MESSAGE_AGE_MS) {
    const ageSeconds = Math.round((Date.now() - timestampMs) / 1000);
    addLog('warn', `[${account.label}] Mensaje de ${author} descartado por antigüedad (${ageSeconds}s).`);
    recordMessageEvent({
      ...baseEvent,
      outcome: 'dropped_age',
      reason: 'antiguedad',
      detail: `Mensaje de ${author} descartado por antigüedad (${ageSeconds}s).`,
    });
    return;
  }

  const result = evaluateMessage(message, targets);

  if (!result.pass) {
    const text = extractText(message.message);
    const authorTargets = targets.filter((target) => matchesTargetUser(message.key, target.targetUser));
    const targetLabel = authorTargets[0]?.label || null;
    let metric = null;

    if (result.reason === 'usuario-no-objetivo' && text) {
      // El autor tiene registros, pero en otra cuenta de WhatsApp.
      const matchesElsewhere = getTargets().some(
        (target) => matchesTargetUser(message.key, target.targetUser) && matchesAnyKeyword(text, targetKeywords(target)),
      );
      if (matchesElsewhere) {
        addLog('warn', `[${account.label}] ${author} tiene registros en otra cuenta de WhatsApp; este número no responderá. Se ignora.`);
        metric = {
          outcome: 'other_account',
          reason: result.reason,
          detail: `${author} tiene registros en otra cuenta de WhatsApp.`,
        };
      } else if (containsAnyKeyword(text, targets)) {
        addLog('warn', `[${account.label}] Mensaje con palabra clave de un número no registrado (${author}) en ${jid}. Se ignora.`);
        metric = {
          outcome: 'keyword_unregistered',
          reason: result.reason,
          detail: `Palabra clave de ${author} en ${jid}.`,
        };
      }
    } else if (result.reason === 'sin-palabra-clave' && authorTargets.length > 0) {
      addLog('info', `[${account.label}] Bot ignorando mensaje de ${author}: no contiene la palabra clave.`);
      metric = {
        outcome: 'no_keyword',
        reason: result.reason,
        targetLabel,
        detail: `Mensaje de ${author} sin la palabra clave.`,
      };
    } else if (result.reason === 'otro-grupo') {
      addLog('info', `[${account.label}] Palabra clave de ${author} ignorada: el grupo no coincide con su registro.`);
      metric = {
        outcome: 'other_group',
        reason: result.reason,
        targetLabel,
        detail: `Palabra clave de ${author} en un grupo distinto al registrado.`,
      };
    } else if (result.reason === 'registro-desactivado') {
      addLog('warn', `[${account.label}] Coincidencia con ${author}, pero su registro está desactivado. Actívalo en el panel para que responda.`);
      metric = {
        outcome: 'disabled',
        reason: result.reason,
        targetLabel,
        detail: `Coincidencia con ${author}; registro desactivado.`,
      };
    }

    if (metric) recordMessageEvent({ ...baseEvent, ...metric });
    return;
  }

  const { target } = result;
  const who = target.label ? `${target.label} (${author})` : author;
  const replyBase = {
    ...baseEvent,
    targetId: target.id,
    targetLabel: target.label || null,
    keyword: result.keyword || null,
    cache: session.groupMetadataCache.peek(jid) ? 'hit' : 'miss',
  };

  // El registro pertenece a esta cuenta; se responde con su configuración.
  addLog('success', `[${account.label}] Mensaje detectado de ${who} con la palabra clave${result.keyword ? ` “${result.keyword}”` : ''}.`);

  // Cola por chat: respuestas del mismo chat en orden (hasta 3 pendientes);
  // chats distintos se procesan en paralelo.
  try {
    await session.chats.run(jid, async () => {
      const queueMs = Date.now() - receivedAt;

      // El límite de frecuencia solo aplica en Modo humano.
      if (humanize) {
        const lastReplyAt = session.lastReplyByTarget.get(target.id) ?? 0;
        if (Date.now() - lastReplyAt < MIN_REPLY_INTERVAL_MS) {
          addLog('warn', `[${account.label}] Modo humano: se omite una respuesta seguida al mismo registro (límite de 15 s).`);
          recordMessageEvent({
            ...replyBase,
            queueMs,
            outcome: 'humanize_skip',
            reason: 'limite-modo-humano',
            detail: `Se omitió una respuesta seguida al mismo registro (límite de 15 s).`,
          });
          return;
        }
      }

      session.lastReplyByTarget.set(target.id, Date.now());
      const sendStartedAt = Date.now();
      try {
        const sent = await sendReply(session.sock, jid, target.response, message);

        // Guarda el id para medir el acuse real de WhatsApp (messages.update).
        if (sent?.key?.id) {
          session.sentMessages.set(sent.key.id, { at: Date.now() });
          if (session.sentMessages.size > 1000) {
            session.sentMessages.delete(session.sentMessages.keys().next().value);
          }
        }

        const sendMs = Date.now() - sendStartedAt;
        const elapsed = Date.now() - receivedAt;
        const totalMs = inboundMs === null ? elapsed : inboundMs + elapsed;

        recordMessageEvent({
          ...replyBase,
          messageId: sent?.key?.id ?? null,
          queueMs,
          sendMs,
          totalMs,
          outcome: sent?.key?.id ? 'replied' : 'error',
          reason: sent?.key?.id ? 'ok' : 'sin-id-envio',
          detail: sent?.key?.id ? null : 'sendMessage no devolvió id de mensaje.',
        });

        const timing =
          inboundMs === null
            ? ''
            : ` · entrada ~${inboundMs} ms · total ~${totalMs} ms`;
        addLog(
          'success',
          `[${account.label}] Respuesta enviada a ${who} en ${elapsed} ms${timing}${humanize ? ' · incluye modo humano' : ''}.`,
        );
      } catch (error) {
        const metric = {
          ...replyBase,
          queueMs,
          sendMs: Date.now() - sendStartedAt,
          totalMs: inboundMs === null ? Date.now() - receivedAt : inboundMs + (Date.now() - receivedAt),
          outcome: 'error',
          reason: 'send-error',
          detail: error?.message ?? String(error),
        };
        if (error && typeof error === 'object') error.metric = metric;
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof QueueFullError) {
      addLog('warn', `[${account.label}] Cola del chat llena para ${who}; se omite este mensaje.`);
      recordMessageEvent({
        ...replyBase,
        outcome: 'queue_full',
        reason: 'queue-full',
        detail: `Cola del chat llena para ${who}.`,
      });
    } else {
      addLog('error', `[${account.label}] No se pudo enviar la respuesta: ${error?.message ?? error}`);
      recordMessageEvent(
        error?.metric ?? {
          ...replyBase,
          outcome: 'error',
          reason: 'send-error',
          detail: error?.message ?? String(error),
        },
      );
    }
  }
}

// Envío de la respuesta.
// Modo humano desactivado (por defecto): responde al instante.
// Modo humano activado en Ajustes: ejecuta la secuencia anti-baneo completa.
async function sendReply(sock, jid, responseText, quotedMessage) {
  const { humanize } = getSettings();

  if (!humanize) {
    return sock.sendMessage(jid, { text: responseText }, { quoted: quotedMessage });
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
  return sock.sendMessage(jid, { text: responseText }, { quoted: quotedMessage });
}
