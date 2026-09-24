import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { Server as SocketServer } from 'socket.io';
import {
  initConfig,
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
import { hasMasterPassword, setupMasterPassword, verifyMasterPassword, usingEnvKey } from './lib/auth.js';
import {
  botEvents,
  getAccountStates,
  getAggregateState,
  getGroups,
  logoutAccount,
  removeAccountSession,
  startAccount,
  startAllAccounts,
  stopAccount,
  stopAllAccounts,
} from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'secreto-de-desarrollo-cambia-esto-en-el-env';

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server);

app.disable('x-powered-by');
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
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 },
  }),
);

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  return res.status(401).json({ error: 'No autenticado.' });
}

function requireAuthPage(req, res, next) {
  if (req.session?.authenticated) return next();
  return res.redirect('/login');
}

// ---- Páginas ----
app.get('/', (req, res) => {
  res.redirect(req.session?.authenticated ? '/dashboard' : '/login');
});

app.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/dashboard', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// ---- Recursos estáticos (CSS y JS públicos) ----
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---- Sesión y contraseña maestra ----
const loginAttempts = new Map();

app.get('/api/session', async (req, res) => {
  res.json({
    authenticated: Boolean(req.session?.authenticated),
    needsSetup: !(await hasMasterPassword()),
  });
});

// Primer inicio: crear la contraseña maestra.
app.post('/api/setup', async (req, res) => {
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

app.post('/api/login', async (req, res) => {
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

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('contestador.sid');
    res.json({ ok: true });
  });
});

// ---- API protegida ----
app.use('/api', requireAuth);

function sendError(res, error) {
  res.status(400).json({ error: error.message, errors: error.validation ?? [] });
}

app.get('/api/status', (req, res) => {
  res.json(getAggregateState());
});

// ---- Ajustes de respuesta ----
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

app.put('/api/settings', async (req, res) => {
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
app.get('/api/accounts', (req, res) => {
  res.json(getAccountStates());
});

app.post('/api/accounts', async (req, res) => {
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

app.put('/api/accounts/:id', async (req, res) => {
  try {
    await updateAccount(req.params.id, { label: req.body?.label });
    res.json(getAccountStates());
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
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

app.post('/api/accounts/:id/start', async (req, res) => {
  try {
    res.json(await startAccount(req.params.id));
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/accounts/:id/stop', async (req, res) => {
  try {
    await stopAccount(req.params.id);
    res.json(getAccountStates());
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/accounts/:id/logout', async (req, res) => {
  try {
    await logoutAccount(req.params.id);
    res.json(getAccountStates());
  } catch (error) {
    sendError(res, error);
  }
});

// Acciones globales: conectar/detener todas las cuentas.
app.post('/api/bot/start', async (req, res) => {
  res.json(await startAllAccounts());
});

app.post('/api/bot/stop', async (req, res) => {
  res.json(await stopAllAccounts());
});

// ---- CRUD de números registrados ----
function accountError(body) {
  const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
  if (!accountId) return 'Selecciona la cuenta de WhatsApp que responderá.';
  if (!getAccount(accountId)) return 'La cuenta de WhatsApp seleccionada no existe.';
  return null;
}

app.get('/api/targets', (req, res) => {
  res.json(getTargets());
});

app.post('/api/targets', async (req, res) => {
  try {
    const problem = accountError(req.body);
    if (problem) return res.status(400).json({ error: problem, errors: [problem] });
    const target = await createTarget(req.body ?? {});
    addLog('success', `Registro agregado: ${target.label || `+${target.targetUser}`} (palabras clave: ${target.keywords.map((k) => `“${k}”`).join(', ')}).`);
    res.status(201).json(target);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/targets/bulk', async (req, res) => {
  try {
    const problem = accountError(req.body);
    if (problem) return res.status(400).json({ error: problem, errors: [problem] });
    const { entries, keywords, keyword, response, groupJid, label, accountId } = req.body ?? {};
    const result = await createTargetsBulk({ entries, keywords, keyword, response, groupJid, label, accountId });
    if (result.created.length > 0) {
      const skippedText = result.skipped.length > 0 ? `, ${result.skipped.length} omitido(s)` : '';
      addLog('success', `Carga masiva: ${result.created.length} registro(s) agregado(s)${skippedText}.`);
    }
    res.status(201).json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.put('/api/targets/:id', async (req, res) => {
  try {
    const problem = accountError(req.body);
    if (problem) return res.status(400).json({ error: problem, errors: [problem] });
    const target = await updateTarget(req.params.id, req.body ?? {});
    addLog('info', `Registro actualizado: ${target.label || `+${target.targetUser}`} (palabras clave: ${target.keywords.map((k) => `“${k}”`).join(', ')}).`);
    res.json(target);
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/targets/:id', async (req, res) => {
  try {
    const target = getTargets().find((item) => item.id === req.params.id);
    await deleteTarget(req.params.id);
    addLog('warn', `Registro eliminado: ${target?.label || `+${target?.targetUser ?? 'desconocido'}`}.`);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.patch('/api/targets/:id/enabled', async (req, res) => {
  try {
    const target = await toggleTarget(req.params.id, req.body?.enabled);
    addLog('info', `Registro ${target.enabled ? 'activado' : 'desactivado'}: ${target.label || `+${target.targetUser}`}.`);
    res.json(target);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/logs', (req, res) => {
  res.json(getLogs());
});

app.get('/api/groups', async (req, res) => {
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

// ---- Arranque ----
await initConfig();
await initAccounts();
const migrated = await migrateLegacySession();
if (migrated) {
  addLog('info', `Sesión anterior detectada: se registró como “${migrated.label}”.`);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Panel disponible en http://localhost:${PORT}`);
});
