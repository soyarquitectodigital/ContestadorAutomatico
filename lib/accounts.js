import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { dataDir } from './config.js';
import { storeReadDoc, storeWriteDoc, usingDb } from './db.js';
import { addLog } from './logger.js';

const ACCOUNTS_VERSION = 1;
const DEFAULTS = { version: ACCOUNTS_VERSION, accounts: [] };

let cache = structuredClone(DEFAULTS);

export function accountsPath() {
  return path.join(dataDir(), 'accounts.json');
}

export function accountsAuthDir() {
  return path.join(dataDir(), 'auth_info');
}

export function accountAuthFolder(id) {
  return path.join(accountsAuthDir(), id);
}

function sanitizeAccount(raw = {}) {
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
    label: String(raw.label ?? '').trim().slice(0, 60),
    createdAt: raw.createdAt ?? new Date().toISOString(),
  };
}

// Lee el documento de cuentas. En modo nube se lee de Turso; si aún no existe
// y hay un accounts.json en disco, se adopta y se sube (migración).
async function readRawAccounts() {
  if (usingDb()) {
    const stored = await storeReadDoc('accounts');
    if (stored !== null) return stored;
    let legacy;
    try {
      legacy = await fs.readFile(accountsPath(), 'utf8');
    } catch {
      return null;
    }
    await storeWriteDoc('accounts', legacy);
    addLog('info', 'Lista de números migrada del disco a la nube.');
    return legacy;
  }
  try {
    return await fs.readFile(accountsPath(), 'utf8');
  } catch {
    return null;
  }
}

async function persist() {
  const json = JSON.stringify(cache, null, 2);
  if (usingDb()) {
    await storeWriteDoc('accounts', json);
    return;
  }
  await fs.mkdir(dataDir(), { recursive: true });
  // Escritura atómica: se escribe un temporal y luego se renombra.
  const tmp = `${accountsPath()}.tmp`;
  await fs.writeFile(tmp, json);
  await fs.rename(tmp, accountsPath());
}

export async function initAccounts() {
  try {
    const rawText = await readRawAccounts();
    if (rawText === null) throw new Error('sin cuentas previas');
    const raw = JSON.parse(rawText);
    cache = {
      version: ACCOUNTS_VERSION,
      accounts: Array.isArray(raw.accounts) ? raw.accounts.map(sanitizeAccount) : [],
    };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return getAccounts();
}

export function getAccounts() {
  return cache.accounts.map((account) => ({ ...account }));
}

export function getAccount(id) {
  return cache.accounts.find((account) => account.id === id) ?? null;
}

export async function createAccount({ label } = {}) {
  const finalLabel = String(label ?? '').trim().slice(0, 60) || `Número ${cache.accounts.length + 1}`;
  const account = sanitizeAccount({ label: finalLabel });
  cache.accounts.push(account);
  await persist();
  return { ...account };
}

export async function updateAccount(id, { label } = {}) {
  const account = cache.accounts.find((item) => item.id === id);
  if (!account) throw new Error('Número de WhatsApp no encontrado.');
  const finalLabel = String(label ?? '').trim().slice(0, 60);
  if (!finalLabel) throw new Error('La etiqueta no puede estar vacía.');
  account.label = finalLabel;
  await persist();
  return { ...account };
}

export async function deleteAccount(id) {
  const before = cache.accounts.length;
  cache.accounts = cache.accounts.filter((account) => account.id !== id);
  if (cache.accounts.length === before) throw new Error('Número de WhatsApp no encontrado.');
  await persist();
}

// Si venimos de la versión de una sola sesión (data/auth_info/creds.json),
// se crea una cuenta "Principal" y se mueve la sesión existente a su carpeta.
// En modo nube no aplica: importAuthFilesToDb (lib/migrate-to-db.js) sube la
// sesión antigua a Turso en lugar de mover carpetas.
export async function migrateLegacySession() {
  if (cache.accounts.length > 0) return null;
  if (usingDb()) return null;
  const legacyCreds = path.join(accountsAuthDir(), 'creds.json');
  try {
    await fs.access(legacyCreds);
  } catch {
    return null;
  }

  const account = await createAccount({ label: 'Principal' });
  const tmp = path.join(dataDir(), 'auth_info_legacy_tmp');
  await fs.rename(accountsAuthDir(), tmp);
  await fs.mkdir(accountsAuthDir(), { recursive: true });
  await fs.rename(tmp, accountAuthFolder(account.id));
  return account;
}
