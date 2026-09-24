import { rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState } from 'baileys';
import NodeCache from '@cacheable/node-cache';
import pino from 'pino';
import QRCode from 'qrcode';
import { getSettings, getTargets } from './lib/config.js';
import { accountAuthFolder, getAccount, getAccounts } from './lib/accounts.js';
import { addLog } from './lib/logger.js';
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
const USER_DEVICES_TTL_SECONDS = 30 * 60; // cache de dispositivos por cuenta (evita consultas USync)
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;
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
    // Metadatos de grupo desde memoria: evita la consulta de red antes de cada envío.
    cachedGroupMetadata: async (jid) => session.groupMetadataCache.get(jid),
    // Lista de dispositivos de participantes con TTL de 30 min (menos consultas USync).
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
  }

  if (connection === 'connecting' && session.status !== 'qr') {
    setStatus(account, 'connecting', 'Conectando...');
  }

  if (connection === 'open') {
    session.reconnectAttempts = 0;
    setStatus(account, 'connected', 'Conectado a WhatsApp');
    addLog('success', `[${account.label}] WhatsApp conectado correctamente.`);
    // Precalienta el cache de grupos en una sola consulta (best-effort).
    session.groupMetadataCache.clear();
    session.sock?.groupFetchAllParticipating?.().catch(() => {
      // Si falla, el cache se llena con los envíos normales.
    });
    // Precalienta dispositivos y sesiones de los grupos con registros para que
    // la primera respuesta no pague el USync ni el intercambio de prekeys.
    void prewarmAccount(account, session);
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

// Deja listos en memoria dispositivos y sesiones Signal de un grupo, usando los
// métodos internos que Baileys expone. Evita el costo del primer envío.
async function prewarmSingleGroup(account, session, jid) {
  if (typeof session.sock?.getUSyncDevices !== 'function' || typeof session.sock?.assertSessions !== 'function') {
    return 0;
  }

  const meta = session.groupMetadataCache.get(jid) ?? (await session.sock.groupMetadata(jid));
  if (Array.isArray(meta?.participants)) session.groupMetadataCache.set(meta);

  const participants = (meta?.participants ?? []).map((participant) => participant.id).filter(Boolean);
  if (participants.length === 0) return 0;

  const deviceList = await session.sock.getUSyncDevices(participants, true, false);
  const deviceJids = deviceList.map((device) => device.jid).filter(Boolean);
  if (deviceJids.length > 0) await session.sock.assertSessions(deviceJids, false);
  return deviceJids.length;
}

// Precalienta los grupos referenciados por los registros de la cuenta.
async function prewarmAccount(account, session) {
  const groups = groupsToPrewarm(getTargets(), account.id, DEFAULT_MAX_PREWARM_GROUPS);
  if (groups.length === 0) return;

  const startedAt = Date.now();
  let devices = 0;
  addLog('info', `[${account.label}] Precalentando ${groups.length} grupo(s) para responder más rápido...`);

  for (const jid of groups) {
    if (session.status !== 'connected' || !session.sock) break;
    try {
      devices += await prewarmSingleGroup(account, session, jid);
    } catch (error) {
      addLog('warn', `[${account.label}] No se pudo precalentar ${jid}: ${error?.message ?? error}`);
    }
  }

  addLog('info', `[${account.label}] Precalentamiento completado en ${Date.now() - startedAt} ms (${devices} dispositivo(s)).`);
}

// Precalienta un grupo concreto al guardar un registro con grupo (best-effort).
export async function prewarmGroup(accountId, groupJid) {
  const account = getAccount(accountId);
  const session = sessions.get(accountId);
  if (!account || !session || !groupJid) return false;
  if (session.status !== 'connected' || !session.sock) return false;

  try {
    await prewarmSingleGroup(account, session, groupJid);
    addLog('info', `[${account.label}] Grupo ${groupJid} precalentado para respuesta inmediata.`);
    return true;
  } catch (error) {
    addLog('warn', `[${account.label}] No se pudo precalentar ${groupJid}: ${error?.message ?? error}`);
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

  // Evita responder dos veces el mismo mensaje (reintentos / duplicados).
  if (session.processedIds.has(message.key.id)) return;
  session.processedIds.add(message.key.id);
  if (session.processedIds.size > 1000) session.processedIds.clear();

  // Anti-baneo: nunca responder a mensajes antiguos (historial).
  const timestampMs = Number(message.messageTimestamp) * 1000;
  if (timestampMs && Date.now() - timestampMs > MAX_MESSAGE_AGE_MS) {
    const ageSeconds = Math.round((Date.now() - timestampMs) / 1000);
    addLog('warn', `[${account.label}] Mensaje de ${describeAuthor(message.key)} descartado por antigüedad (${ageSeconds}s).`);
    return;
  }

  const jid = message.key.remoteJid;
  const author = describeAuthor(message.key);
  const result = evaluateMessage(message, targets);

  if (!result.pass) {
    const text = extractText(message.message);
    const authorTargets = targets.filter((target) => matchesTargetUser(message.key, target.targetUser));

    if (result.reason === 'usuario-no-objetivo' && text) {
      // El autor tiene registros, pero en otra cuenta de WhatsApp.
      const matchesElsewhere = getTargets().some(
        (target) => matchesTargetUser(message.key, target.targetUser) && matchesAnyKeyword(text, targetKeywords(target)),
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
      addLog('warn', `[${account.label}] Coincidencia con ${author}, pero su registro está desactivado. Actívalo en el panel para que responda.`);
    }
    return;
  }

  const { target } = result;
  const who = target.label ? `${target.label} (${author})` : author;

  // El registro pertenece a esta cuenta; se responde con su configuración.
  addLog('success', `[${account.label}] Mensaje detectado de ${who} con la palabra clave${result.keyword ? ` “${result.keyword}”` : ''}.`);

  // Cola por chat: respuestas del mismo chat en orden (hasta 3 pendientes);
  // chats distintos se procesan en paralelo.
  try {
    await session.chats.run(jid, async () => {
      // El límite de frecuencia solo aplica en Modo humano.
      if (humanize) {
        const lastReplyAt = session.lastReplyByTarget.get(target.id) ?? 0;
        if (Date.now() - lastReplyAt < MIN_REPLY_INTERVAL_MS) {
          addLog('warn', `[${account.label}] Modo humano: se omite una respuesta seguida al mismo registro (límite de 15 s).`);
          return;
        }
      }

      session.lastReplyByTarget.set(target.id, Date.now());
      await sendReply(session.sock, jid, target.response, message);

      const elapsed = Date.now() - receivedAt;
      const serverDelta = timestampMs ? Math.max(0, Date.now() - timestampMs) : null;
      const delivery = serverDelta === null ? '' : ` · WhatsApp→bot ~${serverDelta} ms`;
      addLog('success', `[${account.label}] Respuesta enviada a ${who} en ${elapsed} ms${delivery}${humanize ? ' · incluye modo humano' : ''}.`);
    });
  } catch (error) {
    if (error instanceof QueueFullError) {
      addLog('warn', `[${account.label}] Cola del chat llena para ${who}; se omite este mensaje.`);
    } else {
      addLog('error', `[${account.label}] No se pudo enviar la respuesta: ${error?.message ?? error}`);
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
