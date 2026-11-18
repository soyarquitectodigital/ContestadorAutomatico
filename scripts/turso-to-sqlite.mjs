#!/usr/bin/env node
// Respaldo de una base Turso (libsql://) a un archivo SQLite local (.db).
//
// Uso:
//   TURSO_DATABASE_URL=libsql://... \
//   TURSO_AUTH_TOKEN=... \
//   SQLITE_PATH=/ruta/contestadorautomatico.db \
//   node scripts/turso-to-sqlite.mjs
//
// El archivo resultante usa el mismo esquema (store + auth_state) que la app,
// por lo que se puede montar en el contenedor con SQLITE_PATH=/app/db/....db.
// Solo lee de Turso; no modifica la base original.

import fs from 'node:fs';
import path from 'node:path';
import { createClient as createRemote } from '@libsql/client/web';
import { createClient as createLocal } from '@libsql/client/node';

const sourceUrl = (process.env.TURSO_DATABASE_URL ?? '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN ?? '').trim();
const target = (process.env.SQLITE_PATH ?? process.argv[2] ?? '').trim();

if (!sourceUrl || !authToken || !target) {
  console.error('Faltan TURSO_DATABASE_URL, TURSO_AUTH_TOKEN o SQLITE_PATH.');
  process.exit(1);
}

const filePath = path.resolve(target.startsWith('file:') ? target.slice('file:'.length) : target);
const fileUrl = `file:${filePath.replaceAll('\\', '/')}`;
fs.mkdirSync(path.dirname(filePath), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.unlinkSync(`${filePath}${suffix}`);
  } catch {
    // No existía.
  }
}

const remote = createRemote({ url: sourceUrl, authToken });
const local = createLocal({ url: fileUrl });

const store = await remote.execute('SELECT key, value FROM store');
const auth = await remote.execute('SELECT account_id, key, value FROM auth_state');

await local.batch(
  [
    'CREATE TABLE store (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    `CREATE TABLE auth_state (
       account_id TEXT NOT NULL,
       key TEXT NOT NULL,
       value TEXT NOT NULL,
       PRIMARY KEY (account_id, key)
     )`,
  ],
  'write',
);

const statements = [];
for (const row of store.rows) {
  statements.push({ sql: 'INSERT INTO store (key, value) VALUES (?, ?)', args: [row.key, row.value] });
}
for (const row of auth.rows) {
  statements.push({
    sql: 'INSERT INTO auth_state (account_id, key, value) VALUES (?, ?, ?)',
    args: [row.account_id, row.key, row.value],
  });
}

for (let index = 0; index < statements.length; index += 500) {
  await local.batch(statements.slice(index, index + 500), 'write');
}

const storeCount = await local.execute('SELECT COUNT(*) AS c FROM store');
const authCount = await local.execute('SELECT COUNT(*) AS c FROM auth_state');
console.log(`Respaldo creado: ${filePath}`);
console.log(`- store: ${storeCount.rows[0].c} filas`);
console.log(`- auth_state: ${authCount.rows[0].c} filas`);
console.log(`- tamaño: ${(fs.statSync(filePath).size / 1024 / 1024).toFixed(2)} MB`);

local.close();
remote.close();
