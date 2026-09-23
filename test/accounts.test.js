import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDir = path.join(os.tmpdir(), `contestador-accounts-test-${Date.now()}`);
process.env.DATA_DIR = testDir;

const accounts = await import('../lib/accounts.js');

const authDir = path.join(testDir, 'auth_info');
const accountsFile = path.join(testDir, 'accounts.json');

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  await fs.mkdir(testDir, { recursive: true });
});

after(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

test('initAccounts arranca vacío cuando no hay archivo', async () => {
  await fs.rm(accountsFile, { force: true });
  const list = await accounts.initAccounts();
  assert.deepEqual(list, []);
});

test('migrateLegacySession mueve la sesión antigua a una cuenta', async () => {
  await fs.mkdir(authDir, { recursive: true });
  await fs.writeFile(path.join(authDir, 'creds.json'), '{}');

  const migrated = await accounts.migrateLegacySession();
  assert.ok(migrated);
  assert.equal(migrated.label, 'Principal');

  assert.equal(await exists(path.join(authDir, 'creds.json')), false);
  assert.equal(await exists(path.join(authDir, migrated.id, 'creds.json')), true);

  // Con cuentas existentes ya no migra de nuevo.
  assert.equal(await accounts.migrateLegacySession(), null);
});

test('createAccount crea con etiqueta o nombre por defecto', async () => {
  const named = await accounts.createAccount({ label: '  Ventas  ' });
  assert.equal(named.label, 'Ventas');

  const defaulted = await accounts.createAccount({});
  assert.equal(defaulted.label, `Número ${accounts.getAccounts().length}`);
  assert.ok(defaulted.id);
  assert.ok(defaulted.createdAt);
});

test('updateAccount renombra y valida', async () => {
  const [first] = accounts.getAccounts();
  const updated = await accounts.updateAccount(first.id, { label: 'Principal' });
  assert.equal(updated.label, 'Principal');

  await assert.rejects(() => accounts.updateAccount(first.id, { label: '   ' }), /etiqueta/i);
  await assert.rejects(() => accounts.updateAccount('no-existe', { label: 'X' }), /no encontrado/i);
});

test('deleteAccount elimina y avisa si no existe', async () => {
  const before = accounts.getAccounts().length;
  const [first] = accounts.getAccounts();
  await accounts.deleteAccount(first.id);
  assert.equal(accounts.getAccounts().length, before - 1);

  await assert.rejects(() => accounts.deleteAccount('no-existe'), /no encontrado/i);
});
