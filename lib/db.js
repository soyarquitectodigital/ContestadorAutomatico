// Persistencia en Turso (SQLite en la nube) vía HTTP, sin binarios nativos.
//
// Se activa solo si TURSO_DATABASE_URL está definida (y TURSO_AUTH_TOKEN);
// sin ellas la app sigue usando los archivos JSON en DATA_DIR (local/escritorio).
//
// Estructura:
//   store(key, value)         → documentos JSON enteros: 'config', 'accounts', 'master'.
//   auth_state(account, key)  → sesión de WhatsApp por cuenta; la clave es el mismo
//                               nombre que usa useMultiFileAuthState de Baileys
//                               ('creds', 'session-...', 'pre-key-...', ...),
//                               lo que permite importar los archivos tal cual.
//
// Las escrituras de la sesión son muy frecuentes (las claves Signal rotan con
// cada mensaje), así que van en una cola ordenada por cuenta con un reintento,
// sin bloquear el procesamiento de mensajes. flushDbWrites() se llama en el
// cierre ordenado (SIGTERM/SIGINT) para no perder las últimas escrituras.

import { addLog } from './logger.js';

const RETRY_DELAY_MS = 1500;

let client = null;

export function usingDb() {
  return Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_DATABASE_URL.trim());
}

// Punto de entrada para tests: permite inyectar un cliente falso en memoria.
export function setDbClientForTests(fakeClient) {
  client = fakeClient;
}

export async function initDb() {
  if (client) return;
  const url = process.env.TURSO_DATABASE_URL.trim();
  const authToken = (process.env.TURSO_AUTH_TOKEN ?? '').trim() || undefined;
  // Import dinámico: la dependencia solo se carga cuando la DB está configurada.
  const { createClient } = await import('@libsql/client/web');
  client = createClient({ url, authToken });
  await client.batch([
    'CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    `CREATE TABLE IF NOT EXISTS auth_state (
       account_id TEXT NOT NULL,
       key TEXT NOT NULL,
       value TEXT NOT NULL,
       PRIMARY KEY (account_id, key)
     )`,
  ], 'write');
}

function requireClient() {
  if (!client) throw new Error('La base de datos no está inicializada (llama a initDb primero).');
  return client;
}

async function withRetry(operation, description) {
  try {
    return await operation();
  } catch (error) {
    addLog('warn', `${description}: reintentando tras error (${error?.message ?? error})`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return operation();
  }
}

// ---- Documentos JSON (config, accounts, master) ----

export async function storeReadDoc(key) {
  const result = await withRetry(
    () => requireClient().execute({ sql: 'SELECT value FROM store WHERE key = ?', args: [key] }),
    `Lectura de "${key}" en la base de datos`,
  );
  return result.rows.length > 0 ? String(result.rows[0].value) : null;
}

export async function storeWriteDoc(key, value) {
  await withRetry(
    () =>
      requireClient().execute({
        sql: 'INSERT INTO store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        args: [key, value],
      }),
    `Escritura de "${key}" en la base de datos`,
  );
}

// ---- Sesión de WhatsApp (auth_state) ----

// Lee varias claves de una cuenta. Devuelve Map<key, value> solo con las existentes.
export async function authReadRows(accountId, keys) {
  const rows = new Map();
  if (keys.length === 0) return rows;
  const placeholders = keys.map(() => '?').join(', ');
  const result = await withRetry(
    () =>
      requireClient().execute({
        sql: `SELECT key, value FROM auth_state WHERE account_id = ? AND key IN (${placeholders})`,
        args: [accountId, ...keys],
      }),
    'Lectura de claves de sesión en la base de datos',
  );
  for (const row of result.rows) rows.set(String(row.key), String(row.value));
  return rows;
}

// Todas las claves de una cuenta (para saber si ya tiene sesión en la nube).
export async function authReadAllRows(accountId) {
  const result = await withRetry(
    () => requireClient().execute({ sql: 'SELECT key, value FROM auth_state WHERE account_id = ?', args: [accountId] }),
    'Lectura de la sesión en la base de datos',
  );
  const rows = new Map();
  for (const row of result.rows) rows.set(String(row.key), String(row.value));
  return rows;
}

// ---- Cola de escrituras por cuenta (ordenada, con reintento y flush) ----

const writeChains = new Map(); // accountId -> Promise de la última escritura encolada
const pendingWrites = new Set(); // promesas en vuelo, para flushDbWrites()

async function enqueue(accountId, task, description) {
  const previous = writeChains.get(accountId) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      await withRetry(task, description);
    } catch (error) {
      // El reintento también falló: se registra y la cola sigue con lo siguiente.
      addLog('error', `${description}: escritura perdida (${error?.message ?? error})`);
    }
  });
  writeChains.set(accountId, next);
  pendingWrites.add(next);
  try {
    await next;
  } finally {
    pendingWrites.delete(next);
    if (writeChains.get(accountId) === next) writeChains.delete(accountId);
  }
}

// Encola upserts/deletes de claves de sesión (value null = borrar). Sin await:
// las claves nuevas ya están en la caché en memoria del adaptador.
export function authEnqueueWrite(accountId, ops) {
  if (ops.length === 0) return Promise.resolve();
  return enqueue(
    accountId,
    () =>
      requireClient().batch(
        ops.map((op) =>
          op.value === null
            ? { sql: 'DELETE FROM auth_state WHERE account_id = ? AND key = ?', args: [accountId, op.key] }
            : {
                sql: 'INSERT INTO auth_state (account_id, key, value) VALUES (?, ?, ?) ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value',
                args: [accountId, op.key, op.value],
              },
        ),
        'write',
      ),
    `Escritura de ${ops.length} clave(s) de sesión`,
  );
}

// Borra toda la sesión de una cuenta, encolado tras sus escrituras pendientes.
export function authDeleteAccount(accountId) {
  return enqueue(
    accountId,
    () => requireClient().execute({ sql: 'DELETE FROM auth_state WHERE account_id = ?', args: [accountId] }),
    'Borrado de la sesión en la base de datos',
  );
}

// Espera a que terminen las escrituras en vuelo (cierre ordenado).
export async function flushDbWrites() {
  await Promise.all([...pendingWrites]);
}
