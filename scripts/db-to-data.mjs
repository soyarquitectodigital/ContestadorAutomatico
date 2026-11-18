#!/usr/bin/env node
// Convierte un volcado SQLite de Turso (tablas store + auth_state) al formato
// de datos local de la app: config.json, accounts.json, master.json y
// auth_info/<accountId>/<clave>.json.
//
// Uso: node scripts/db-to-data.mjs <archivo.db> <carpeta-destino>
//
// Pensado para preparar una instancia aislada (standby) sin tocar la Turso
// original. La sesión de WhatsApp copiada NO debe conectarse mientras la
// instancia original siga usando la misma cuenta.

import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [dbPath, outDir] = process.argv.slice(2);
if (!dbPath || !outDir) {
  console.error('Uso: node scripts/db-to-data.mjs <archivo.db> <carpeta-destino>');
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
  .all()
  .map((row) => row.name);

for (const table of ['store', 'auth_state']) {
  if (!tables.includes(table)) {
    throw new Error(`El archivo no tiene la tabla "${table}".`);
  }
}

const store = new Map(
  db.prepare('SELECT key, value FROM store').all().map((row) => [String(row.key), String(row.value)]),
);

for (const key of ['config', 'accounts', 'master']) {
  if (!store.has(key)) throw new Error(`Falta el documento "${key}" en store.`);
}

await mkdir(outDir, { recursive: true });
for (const key of ['config', 'accounts', 'master']) {
  await writeFile(path.join(outDir, `${key}.json`), store.get(key), { encoding: 'utf8', mode: 0o600 });
}

const accountsDoc = JSON.parse(store.get('accounts'));
const accountIds = new Set((accountsDoc.accounts ?? []).map((account) => account.id));

// Mismo mapeo que usa la app para los nombres de archivo de Baileys.
const fixKey = (name) => name.replace(/\//g, '__').replace(/:/g, '-');

const authRows = db.prepare('SELECT account_id, key, value FROM auth_state').all();
let written = 0;
for (const row of authRows) {
  const accountId = String(row.account_id);
  if (!accountIds.has(accountId)) continue;
  const safeKey = fixKey(String(row.key));
  if (!safeKey || path.basename(safeKey) !== safeKey || safeKey.includes('..')) {
    throw new Error(`Clave de sesión no válida: ${row.key}`);
  }
  const folder = path.join(outDir, 'auth_info', accountId);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${safeKey}.json`), String(row.value), { encoding: 'utf8', mode: 0o600 });
  written += 1;
}

const manifest = {
  source: path.basename(dbPath),
  importedAt: new Date().toISOString(),
  accounts: (accountsDoc.accounts ?? []).map((account) => ({ id: account.id, label: account.label })),
  authKeys: written,
  storeKeys: [...store.keys()],
};
await writeFile(path.join(outDir, 'import-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`Importado en ${outDir}`);
console.log(`- documentos: ${[...store.keys()].join(', ')}`);
console.log(`- cuentas: ${manifest.accounts.map((account) => account.label).join(', ') || 'ninguna'}`);
console.log(`- claves de sesión: ${written}`);
if (!written) {
  console.warn('Aviso: no se escribió ninguna clave de sesión.');
}
