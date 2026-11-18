import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { Server as SocketServer } from 'socket.io';
import {
  initConfig,
  dataDir,
  getTargets,
  getSettings,
  updateSettings,
  createTarget,
  createTargetsBulk,
  updateTarget,
  deleteTarget,
  toggleTarget,
  deleteTargetsByAccount,
  assignUnassignedTargets,
} from './lib/config.js';
import {
  initAccounts,
  getAccount,
  getAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  migrateLegacySession,
} from './lib/accounts.js';
import { addLog, getLogs, logEvents } from './lib/logger.js';
import {
  flushMetrics,
  getMetricsEvents,
  getMetricsSummary,
  getSystemEvents,
  initMetrics,
} from './lib/metrics.js';
import { startSelfPing } from './lib/self-ping.js';
import { flushDbWrites, initDb, usingDb } from './lib/db.js';
import { importAuthFilesToDb } from './lib/migrate-to-db.js';
import { hasMasterPassword, setupMasterPassword, verifyMasterPassword, usingEnvKey } from './lib/auth.js';
import {
  botEvents,
  getAccountStates,
  getAggregateState,
  getGroups,
  logoutAccount,
  prewarmGroup,
  removeAccountSession,
  startAccount,
  startAllAccounts,
  stopAccount,
  stopAllAccounts,
} from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 3000;
// En escritorio se usa 127.0.0.1 para que el panel no sea accesible desde la red.
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_SECRET = process.env.SESSION_SECRET || 'secreto-de-desarrollo-cambia-esto-en-el-env';
// Prefijo público del panel (por ejemplo /cuenta-1). Vacío = servido en la raíz.
const BASE_PATH = normalizeBasePath(process.env.BASE_PATH);
// Correo de referencia del cliente; se muestra enmascarado en las cards.
const ACCOUNT_REFERENCE = maskEmail(process.env.ACCOUNT_REFERENCE);
// Modo standby: solo lectura, sin conectar WhatsApp ni escribir en la base.
const STANDBY = isEnabled(process.env.STANDBY);
// Al arrancar, conectar automáticamente todas las cuentas de la instancia.
const AUTO_START = isEnabled(process.env.AUTO_START);

function normalizeBasePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function maskEmail(value) {
  const email = String(value ?? '').trim();
  const match = email.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!match) return '';
  const local = match[1];
  const domain = match[2].replace(/[^A-Za-z0-9.-]/g, '');
  // Conserva la parte anterior a los números (mínimo 6) para que dos correos
  // del mismo dominio se puedan distinguir: transportesmg*** vs transportesvazquez***.
  const digitIndex = local.search(/\d/);
  const keep = digitIndex > 0 ? Math.max(6, digitIndex) : Math.min(local.length, 8);
  const visible = local.slice(0, keep).replace(/[^A-Za-z0-9._%+-]/g, '');
  if (!visible || !domain) return '';
  return `${visible}***@${domain}`;
}

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, BASE_PATH ? { path: `${BASE_PATH}/socket.io` } : {});
const router = express.Router();

// Las vistas llevan marcadores para el prefijo, la referencia y el standby.
function renderView(name) {
  return fs
    .readFileSync(path.join(__dirname, 'views', name), 'utf8')
    .replaceAll('{{BASE_PATH}}', BASE_PATH)
    .replaceAll('{{ACCOUNT_REFERENCE}}', ACCOUNT_REFERENCE)
    .replaceAll('{{STANDBY}}', STANDBY ? '1' : '');
}
const loginPage = renderView('login.html');
const dashboardPage = renderView('dashboard.html');
const metricsPage = renderView('metrics.html');

app.disable('x-powered-by');
// Detrás de Nginx: usa X-Forwarded-Proto para cookies Secure y req.ip real.
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));

// Health check público (Render, Docker, monitoreo).
app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.use(
  session({
    name: 'contestador.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      path: BASE_PATH || '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: 12 * 60 * 60 * 1000,
    },
  }),
);

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  return res.status(401).json({ error: 'No autenticado.' });
}

function requireAuthPage(req, res, next) {
  if (req.session?.authenticated) return next();
  return res.redirect(`${BASE_PATH}/login`);
}

// ---- Páginas ----
router.get('/', (req, res) => {
  res.redirect(`${BASE_PATH}${req.session?.authenticated ? '/dashboard' : '/login'}`);
});

router.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect(`${BASE_PATH}/dashboard`);
  res.type('html').send(loginPage);
});

router.get('/dashboard', requireAuthPage, (req, res) => {
  res.type('html').send(dashboardPage);
});

router.get('/metrics', requireAuthPage, (req, res) => {
  res.type('html').send(metricsPage);
});

// ---- Recursos estáticos (CSS y JS públicos) ----
router.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---- Sesión y contraseña maestra ----
const loginAttempts = new Map();

router.get('/api/session', async (req, res) => {
  res.json({
    authenticated: Boolean(req.session?.authenticated),
    needsSetup: !(await hasMasterPassword()),
  });
});

// Primer inicio: crear la contraseña maestra.
router.post('/api/setup', async (req, res) => {
  try {
    if (await hasMasterPassword()) {
      return res.status(409).json({ error: 'La contraseña maestra ya está configurada.' });
    }
    await setupMasterPassword(req.body?.password);
    req.session.regenerate((error) => {
      if (error) return res.status(500).json({ error: 'No se pudo iniciar la sesión.' });
      req.session.authenticated = true;
      addLog('info', 'Contraseña maestra creada. Sesión iniciada.');
      res.json({ ok: true });
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/api/login', async (req, res) => {
  const ip = req.ip || 'local';
  const attempt = loginAttempts.get(ip);
  if (attempt?.blockedUntil > Date.now()) {
    return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera un minuto.' });
  }

  const valid = await verifyMasterPassword(req.body?.password);
  if (!valid) {
    const count = (attempt?.count ?? 0) + 1;
    loginAttempts.set(ip, { count, blockedUntil: count >= 5 ? Date.now() + 60 * 1000 : 0 });
    addLog('warn', 'Intento de acceso fallido al panel.');
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }

  loginAttempts.delete(ip);
  req.session.regenerate((error) => {
    if (error) return res.status(500).json({ error: 'No se pudo iniciar la sesión.' });
    req.session.authenticated = true;
    addLog('info', 'Acceso al panel iniciado.');
    res.json({ ok: true });
  });
});

router.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('contestador.sid', { path: BASE_PATH || '/' });
    res.json({ ok: true });
  });
});

// ---- API protegida ----
router.use('/api', requireAuth);

// Modo standby: permite consultar el panel pero bloquea cualquier escritura.
// Así una instancia de respaldo no modifica Turso ni conecta la sesión de
// WhatsApp que sigue usando el servicio principal.
if (STANDBY) {
  router.use(
    ['/api/setup', '/api/accounts', '/api/bot', '/api/targets', '/api/settings'],
    (req, res, next) => {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(409).json({ error: 'Instancia en standby: los cambios están deshabilitados.' });
    },
  );
}

function sendError(res, error) {
  res.status(400).json({ error: error.message, errors: error.validation ?? [] });
}

router.get('/api/status', (req, res) => {
  res.json(getAggregateState());
});

// ---- Ajustes de respuesta ----
router.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

router.put('/api/settings', async (req, res) => {
  try {
    const settings = await updateSettings(req.body ?? {});
    addLog(
      'info',
      settings.humanize
        ? 'Modo humano (anti-baneo) activado: las respuestas esperan y simulan escritura.'
        : 'Respuesta inmediata activada: el bot contesta al instante.',
    );
    res.json(settings);
  } catch (error) {
    sendError(res, error);
  }
});

// ---- Cuentas de WhatsApp (varias sesiones con QR propio) ----
router.get('/api/accounts', (req, res) => {
  res.json(getAccountStates());
});

router.post('/api/accounts', async (req, res) => {
  try {
    const account = await createAccount({ label: req.body?.label });
    addLog('info', `Número de WhatsApp agregado: ${account.label}.`);
    const assigned = await assignUnassignedTargets(account.id);
    if (assigned > 0) {
      addLog('info', `Se asignaron ${assigned} registro(s) sin cuenta a “${account.label}”.`);
    }
    res.status(201).json({ ...account, status: 'disconnected', detail: 'Sin conectar', qr: null, connected: false });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/api/accounts/:id', async (req, res) => {
  try {
    await updateAccount(req.params.id, { label: req.body?.label });
    res.json(getAccountStates());
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/api/accounts/:id', async (req, res) => {
  try {
    const account = getAccount(req.params.id);
    if (!account) throw new Error('Número de WhatsApp no encontrado.');
    await removeAccountSession(account.id);
    await deleteAccount(account.id);
    const removed = await deleteTargetsByAccount(account.id);
    addLog(
      'warn',
      `Número de WhatsApp eliminado: ${account.label}${removed > 0 ? ` (se eliminaron ${removed} registro(s))` : ''}.`,
    );
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/api/accounts/:id/start', async (req, res) => {
  try {
    res.json(await startAccount(req.params.id));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/api/accounts/:id/stop', async (req, res) => {
  try {
    await stopAccount(req.params.id);
    res.json(getAccountStates());
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/api/accounts/:id/logout', async (req, res) => {
  try {
    await logoutAccount(req.params.id);
    res.json(getAccountStates());
  } catch (error) {
    sendError(res, error);
  }
});

// Acciones globales: conectar/detener todas las cuentas.
router.post('/api/bot/start', async (req, res) => {
  res.json(await startAllAccounts());
});

router.post('/api/bot/stop', async (req, res) => {
  res.json(await stopAllAccounts());
});

// ---- CRUD de números registrados ----
function accountError(body) {
  const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
  if (!accountId) return 'Selecciona la cuenta de WhatsApp que responderá.';
  if (!getAccount(accountId)) return 'La cuenta de WhatsApp seleccionada no existe.';
  return null;
}

const BUSY_ACCOUNT_STATUSES = ['connecting', 'qr', 'connected', 'reconnecting'];

function accountHasEnabledTargets(accountId, targets = getTargets()) {
  return targets.some((target) => target.accountId === accountId && target.enabled !== false);
}

// Conecta la cuenta solo cuando de verdad tiene registros activos. Así las
// cuentas sin trabajo no consumen CPU, no duplican sesiones y no entran en el
// bucle de QR de una cuenta que nunca se terminó de vincular.
function ensureAccountStarted(accountId) {
  const state = getAccountStates().find((item) => item.id === accountId);
  if (!state || BUSY_ACCOUNT_STATUSES.includes(state.status)) return;
  addLog('info', `Conectando “${state.label}” porque tiene registros activos...`);
  startAccount(accountId).catch((error) => {
    addLog('error', `No se pudo conectar “${state.label}”: ${error?.message ?? error}`);
  });
}

router.get('/api/targets', (req, res) => {
  res.json(getTargets());
});

router.post('/api/targets', async (req, res) => {
  try {
    const problem = accountError(req.body);
    if (problem) return res.status(400).json({ error: problem, errors: [problem] });
    const target = await createTarget(req.body ?? {});
    addLog('success', `Registro agregado: ${target.label || `+${target.targetUser}`} (palabras clave: ${target.keywords.map((k) => `“${k}”`).join(', ')}).`);
    if (target.enabled) ensureAccountStarted(target.accountId);
    if (target.groupJid) void prewarmGroup(target.accountId, target.groupJid);
    res.status(201).json(target);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/api/targets/bulk', async (req, res) => {
  try {
    const problem = accountError(req.body);
    if (problem) return res.status(400).json({ error: problem, errors: [problem] });
    const { entries, keywords, keyword, response, groupJid, label, accountId } = req.body ?? {};
    const result = await createTargetsBulk({ entries, keywords, keyword, response, groupJid, label, accountId });
    if (result.created.length > 0) {
      const skippedText = result.skipped.length > 0 ? `, ${result.skipped.length} omitido(s)` : '';
      addLog('success', `Carga masiva: ${result.created.length} registro(s) agregado(s)${skippedText}.`);
      if (result.created.some((item) => item.enabled)) ensureAccountStarted(accountId);
      if (groupJid) void prewarmGroup(accountId, groupJid);
    }
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/api/targets/:id', async (req, res) => {
  try {
    const problem = accountError(req.body);
    if (problem) return res.status(400).json({ error: problem, errors: [problem] });
    const target = await updateTarget(req.params.id, req.body ?? {});
    addLog('info', `Registro actualizado: ${target.label || `+${target.targetUser}`} (palabras clave: ${target.keywords.map((k) => `“${k}”`).join(', ')}).`);
    if (target.enabled) ensureAccountStarted(target.accountId);
    if (target.groupJid) void prewarmGroup(target.accountId, target.groupJid);
    res.json(target);
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/api/targets/:id', async (req, res) => {
  try {
    const target = getTargets().find((item) => item.id === req.params.id);
    await deleteTarget(req.params.id);
    addLog('warn', `Registro eliminado: ${target?.label || `+${target?.targetUser ?? 'desconocido'}`}.`);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch('/api/targets/:id/enabled', async (req, res) => {
  try {
    const target = await toggleTarget(req.params.id, req.body?.enabled);
    // Al reactivar, conecta la cuenta si hace falta y deja el grupo caliente.
    if (target.enabled) ensureAccountStarted(target.accountId);
    if (target.enabled && target.groupJid) void prewarmGroup(target.accountId, target.groupJid);
    addLog('info', `Registro ${target.enabled ? 'activado' : 'desactivado'}: ${target.label || `+${target.targetUser}`}.`);
    res.json(target);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/api/logs', (req, res) => {
  res.json(getLogs());
});

// ---- Métricas de latencia ----
function metricHours(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 24;
  return Math.min(168, Math.max(1, number));
}

function metricLimit(value, fallback = 100) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(500, Math.max(1, Math.floor(number)));
}

router.get('/api/metrics/summary', async (req, res) => {
  try {
    const summary = await getMetricsSummary({
      hours: metricHours(req.query.hours),
      accountId: typeof req.query.accountId === 'string' ? req.query.accountId : null,
    });
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: `No se pudieron leer las métricas: ${error?.message ?? error}` });
  }
});

router.get('/api/metrics/events', async (req, res) => {
  try {
    const events = await getMetricsEvents({
      hours: metricHours(req.query.hours),
      accountId: typeof req.query.accountId === 'string' ? req.query.accountId : null,
      outcome: typeof req.query.outcome === 'string' ? req.query.outcome : null,
      limit: metricLimit(req.query.limit, 100),
    });
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: `No se pudieron leer las métricas: ${error?.message ?? error}` });
  }
});

router.get('/api/metrics/system', async (req, res) => {
  try {
    const events = await getSystemEvents({
      hours: metricHours(req.query.hours),
      accountId: typeof req.query.accountId === 'string' ? req.query.accountId : null,
      limit: metricLimit(req.query.limit, 100),
    });
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: `No se pudieron leer las métricas: ${error?.message ?? error}` });
  }
});

router.get('/api/groups', async (req, res) => {
  try {
    res.json(await getGroups(req.query.accountId || null));
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

// ---- Socket.IO: cuentas y logs en vivo ----
io.on('connection', (socket) => {
  socket.emit('accounts', getAccountStates());
  socket.emit('logs', getLogs());
});

logEvents.on('log', (entry) => io.emit('log', entry));
botEvents.on('accounts', (states) => io.emit('accounts', states));

// ---- Montaje bajo el prefijo público ----
app.use(BASE_PATH || '/', router);

// ---- Manejo de errores ----
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada.' });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

process.on('unhandledRejection', (error) => {
  addLog('error', `Error no controlado: ${error?.message ?? error}`);
});

// ---- Cierre ordenado ----
// En Render cada despliegue envía SIGTERM antes de apagar el contenedor. Cerrar
// las sesiones de WhatsApp antes de salir evita credenciales a medias y que se
// pida escanear el QR de nuevo tras la actualización.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  addLog('info', `Cerrando (${signal}): guardando sesiones de WhatsApp...`);
  try {
    await stopAllAccounts();
    // En modo nube: espera a que lleguen a Turso las escrituras en vuelo.
    await flushDbWrites();
    await flushMetrics();
  } catch (error) {
    addLog('error', `No se pudieron detener las cuentas: ${error?.message ?? error}`);
  }
  server.close(() => process.exit(0));
  // Failsafe: no quedarse colgado si alguna conexión no cierra.
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});

// ---- Arranque ----
// Con TURSO_DATABASE_URL todo se guarda en la nube (Turso) y el disco deja de
// ser necesario; sin ella se usan los archivos JSON de DATA_DIR como siempre.
if (usingDb()) {
  await initDb();
  addLog(
    'info',
    process.env.SQLITE_PATH
      ? `Persistencia local (SQLite): ${process.env.SQLITE_PATH}`
      : 'Persistencia en la nube activada (Turso). El disco local solo se usa como respaldo de migración.',
  );
} else {
  addLog('info', `Carpeta de datos: ${dataDir()}`);
}
await initConfig();
await initAccounts();
await initMetrics();
const migrated = await migrateLegacySession();
if (migrated) {
  addLog('info', `Sesión anterior detectada: se registró como “${migrated.label}”.`);
}
// En modo nube: sube a Turso las sesiones de WhatsApp que haya en disco.
if (usingDb()) {
  await importAuthFilesToDb();
}
// Registros del formato antiguo "cualquier cuenta": se asignan al primer número
// registrado para que cada cuenta tenga su propia configuración independiente.
const [firstAccount] = getAccounts();
if (firstAccount) {
  const assigned = await assignUnassignedTargets(firstAccount.id);
  if (assigned > 0) {
    addLog('info', `Se asignaron ${assigned} registro(s) sin cuenta a “${firstAccount.label}”.`);
  }
}
addLog(
  'info',
  usingEnvKey()
    ? 'Panel iniciado. Contraseña maestra tomada de MASTER_KEY (.env).'
    : 'Panel iniciado. La contraseña maestra se crea en el primer acceso.',
);

// `serverReady` resuelve con el puerto real (PORT=0 pide uno libre, útil en escritorio).
export const serverReady = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, HOST, () => {
    const { port } = server.address();
    console.log(`Panel disponible en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`);
    resolve(port);
  });
});
await serverReady;

if (AUTO_START) {
  const targets = getTargets();
  const accounts = getAccounts();
  const accountsWithTargets = accounts.filter((account) => accountHasEnabledTargets(account.id, targets));

  if (accountsWithTargets.length === 0) {
    addLog('info', 'Auto-start: no hay cuentas con registros activos; no se conecta ninguna.');
  } else {
    addLog(
      'info',
      `Auto-start activado: conectando ${accountsWithTargets.length} de ${accounts.length} cuenta(s) con registros activos...`,
    );
  }

  for (const account of accounts) {
    if (!accountsWithTargets.includes(account)) {
      addLog('info', `Auto-start: “${account.label}” sin registros activos; se omite.`);
    }
  }

  for (const account of accountsWithTargets) {
    startAccount(account.id).catch((error) => {
      addLog('error', `Auto-start de “${account.label}”: ${error?.message ?? error}`);
    });
  }
}

// Auto-ping a la URL pública para que Render no suspenda el servicio
// (sustituye al antiguo workflow de GitHub Actions). No hace nada en local.
startSelfPing();
