import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Modo nube con un cliente falso en memoria (sin red): el resto de la app no
// nota la diferencia porque db.js concentra todas las consultas.
process.env.TURSO_DATABASE_URL = 'libsql://fake-test';
const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contestador-db-test-'));
process.env.DATA_DIR = testDir;

// Cliente falso que imita a @libsql/client/web para las consultas de db.js.
function createFakeClient() {
  const store = new Map(); // key -> value
  const auth = new Map(); // accountId + SEP + key -> value
  const SEP = ' ';
  const authId = (accountId, key) => `${accountId}${SEP}${key}`;

  return {
    store,
    auth,
    async execute({ sql, args = [] }) {
      if (sql === 'SELECT value FROM store WHERE key = ?') {
        return { rows: store.has(args[0]) ? [{ value: store.get(args[0]) }] : [] };
      }
      if (sql.startsWith('INSERT INTO store')) {
        store.set(args[0], args[1]);
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO auth_state')) {
        auth.set(authId(args[0], args[1]), args[2]);
        return { rows: [] };
      }
      if (sql.startsWith('SELECT key, value FROM auth_state WHERE account_id = ? AND key IN')) {
        const [accountId, ...keys] = args;
        const rows = [];
        for (const key of keys) {
          const id = authId(accountId, key);
          if (auth.has(id)) rows.push({ key, value: auth.get(id) });
        }
        return { rows };
      }
      if (sql === 'SELECT key, value FROM auth_state WHERE account_id = ?') {
        const prefix = authId(args[0], '');
        const rows = [];
        for (const [id, value] of auth) {
          if (id.startsWith(prefix)) rows.push({ key: id.slice(prefix.length), value });
        }
        return { rows };
      }
      if (sql === 'DELETE FROM auth_state WHERE account_id = ? AND key = ?') {
        auth.delete(authId(args[0], args[1]));
        return { rows: [] };
      }
      if (sql === 'DELETE FROM auth_state WHERE account_id = ?') {
        const prefix = authId(args[0], '');
        for (const id of [...auth.keys()]) if (id.startsWith(prefix)) auth.delete(id);
        return { rows: [] };
      }
      throw new Error(`SQL no soportada por el cliente falso: ${sql}`);
    },
    async batch(statements) {
      for (const statement of statements) {
        if (typeof statement === 'string') continue; // CREATE TABLE del init real
        await this.execute(statement);
      }
      return [];
    },
  };
}

const fake = createFakeClient();
const db = await import('../lib/db.js');
db.setDbClientForTests(fake);
await db.initDb();

const { useDbAuthState, clearDbAuthState } = await import('../lib/auth-state.js');

test('store: escritura y lectura de documentos', async () => {
  assert.equal(await db.storeReadDoc('config'), null);
  await db.storeWriteDoc('config', '{"version":3}');
  assert.equal(await db.storeReadDoc('config'), '{"version":3}');
  await db.storeWriteDoc('config', '{"version":4}');
  assert.equal(await db.storeReadDoc('config'), '{"version":4}');
});

test('auth-state: guarda creds y claves, y otra instancia las lee de la nube', async () => {
  const first = await useDbAuthState('acc-1');
  assert.ok(first.state.creds?.noiseKey, 'genera creds nuevas la primera vez');
  await first.saveCreds();
  await first.state.keys.set({
    session: { '5212345678.0': { remote: 'data' } },
    'pre-key': { '7': { pk: true } },
  });
  await db.flushDbWrites();

  const second = await useDbAuthState('acc-1');
  assert.ok(second.state.creds?.noiseKey, 'recupera creds de la nube');
  const got = await second.state.keys.get('session', ['5212345678.0', 'no-existe.9']);
  assert.deepEqual(got['5212345678.0'], { remote: 'data' });
  assert.equal(got['no-existe.9'], null);
  const prekey = await second.state.keys.get('pre-key', ['7']);
  assert.deepEqual(prekey['7'], { pk: true });
});

test('auth-state: valor null borra la clave y las cuentas están aisladas', async () => {
  const a = await useDbAuthState('acc-1');
  await a.state.keys.set({ session: { '5212345678.0': null } });
  const b = await useDbAuthState('acc-2');
  await b.state.keys.set({ session: { '999.0': { other: 'account' } } });
  await db.flushDbWrites();

  const rows1 = await db.authReadAllRows('acc-1');
  assert.equal(rows1.has('session-5212345678.0'), false);
  assert.equal(rows1.has('creds'), true);

  const rows2 = await db.authReadAllRows('acc-2');
  assert.deepEqual([...rows2.keys()], ['session-999.0']);
});

test('auth-state: clearDbAuthState borra toda la sesión de la cuenta', async () => {
  await clearDbAuthState('acc-2');
  assert.equal((await db.authReadAllRows('acc-2')).size, 0);
});

test('migración: sube al cloud la sesión antigua suelta y las carpetas por cuenta', async () => {
  const { initAccounts, getAccounts, accountsAuthDir } = await import('../lib/accounts.js');
  const { importAuthFilesToDb } = await import('../lib/migrate-to-db.js');

  await initAccounts();
  assert.equal(getAccounts().length, 0);

  // Sesión antigua de una sola cuenta: archivos sueltos en auth_info/.
  const authDir = accountsAuthDir();
  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(path.join(authDir, 'creds.json'), '{"legacy":true}');
  await fs.writeFile(path.join(authDir, 'pre-key-1.json'), '{"pk":1}');

  await importAuthFilesToDb();

  const [principal] = getAccounts();
  assert.ok(principal, 'crea la cuenta Principal para la sesión antigua');
  assert.equal(principal.label, 'Principal');
  const legacyRows = await db.authReadAllRows(principal.id);
  assert.equal(legacyRows.get('creds'), '{"legacy":true}');
  assert.equal(legacyRows.get('pre-key-1'), '{"pk":1}');

  // Carpeta por cuenta: solo importa si la cuenta no tiene sesión en la nube.
  const folder = path.join(authDir, principal.id);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'creds.json'), '{"nuevo":true}');
  await importAuthFilesToDb();
  const after = await db.authReadAllRows(principal.id);
  assert.equal(after.get('creds'), '{"legacy":true}', 'no pisa la sesión que ya está en la nube');
});
