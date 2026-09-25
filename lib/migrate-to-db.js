// Migración única: sube a Turso las sesiones de WhatsApp que existan en disco.
//
// Corre al arrancar solo en modo nube (TURSO_DATABASE_URL definida). Los
// documentos (config, accounts, master) se migran solos al leerse; aquí se
// importan las carpetas de auth_info:
//
//   auth_info/<accountId>/*.json  → filas de esa cuenta (si aún no tiene sesión
//                                   en la nube). La clave es el nombre del
//                                   archivo sin .json, igual que en Baileys.
//   auth_info/*.json (sueltos)    → sesión antigua de una sola cuenta: crea la
//                                   cuenta "Principal" si no hay ninguna y la
//                                   importa ahí (equivale a migrateLegacySession).
//
// Los archivos del disco NO se borran: quedan como respaldo local.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { accountsAuthDir, createAccount, getAccounts } from './accounts.js';
import { authEnqueueWrite, authReadAllRows } from './db.js';
import { addLog } from './logger.js';

async function listJsonFiles(folder) {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Copia los .json de una carpeta a filas de la cuenta. Devuelve cuántas claves
// importó (0 si la cuenta ya tiene sesión en la nube o la carpeta está vacía).
async function importFolder(accountId, folder) {
  const existing = await authReadAllRows(accountId);
  if (existing.size > 0) return 0;

  const files = await listJsonFiles(folder);
  const ops = [];
  for (const file of files) {
    const content = await fs.readFile(path.join(folder, file), 'utf8');
    ops.push({ key: file.replace(/\.json$/, ''), value: content });
  }
  if (ops.length > 0) await authEnqueueWrite(accountId, ops);
  return ops.length;
}

export async function importAuthFilesToDb() {
  const authDir = accountsAuthDir();
  let entries;
  try {
    entries = await fs.readdir(authDir, { withFileTypes: true });
  } catch {
    return; // no hay carpeta auth_info: nada que migrar
  }

  // Sesión antigua de una sola cuenta: creds.json suelto en auth_info/.
  if (entries.some((entry) => entry.isFile() && entry.name === 'creds.json')) {
    let [account] = getAccounts();
    if (!account) {
      account = await createAccount({ label: 'Principal' });
      addLog('info', `Sesión anterior detectada: se registró como “${account.label}”.`);
    }
    const count = await importFolder(account.id, authDir);
    if (count > 0) {
      addLog('info', `Sesión de “${account.label}” importada a la nube (${count} clave(s)).`);
    }
  }

  // Sesiones por cuenta: una subcarpeta por número de WhatsApp.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const account = getAccounts().find((item) => item.id === entry.name);
    if (!account) continue; // carpeta huérfana de una cuenta eliminada
    const count = await importFolder(account.id, path.join(authDir, entry.name));
    if (count > 0) {
      addLog('info', `Sesión de “${account.label}” importada a la nube (${count} clave(s)).`);
    }
  }
}
