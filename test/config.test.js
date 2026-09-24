import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDir = path.join(os.tmpdir(), `contestador-config-test-${Date.now()}`);
process.env.DATA_DIR = testDir;

const config = await import('../lib/config.js');
const configFile = path.join(testDir, 'config.json');

before(async () => {
  await fs.mkdir(testDir, { recursive: true });
});

after(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

test('initConfig arranca vacío cuando no hay archivo', async () => {
  await fs.rm(configFile, { force: true });
  const targets = await config.initConfig();
  assert.deepEqual(targets, []);
});

test('initConfig migra el formato antiguo de un solo registro', async () => {
  await fs.writeFile(
    configFile,
    JSON.stringify({
      targetUser: '584241234567',
      keyword: 'flores amarillas',
      response: 'Yo quiero una',
      groupJid: '',
    }),
  );
  const targets = await config.initConfig();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].label, 'Principal');
  assert.equal(targets[0].targetUser, '584241234567');
  assert.equal(targets[0].enabled, true);
  assert.ok(targets[0].id);
  assert.deepEqual(targets[0].keywords, ['flores amarillas']);

  // La migración se persiste en el formato nuevo.
  const saved = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(saved.version, 3);
  assert.equal(saved.targets.length, 1);
});

test('initConfig migra keyword (v2) a keywords y persiste la versión nueva', async () => {
  await fs.writeFile(
    configFile,
    JSON.stringify({
      version: 2,
      targets: [
        { targetUser: '584241234567', keyword: 'flores amarillas', response: 'ok', groupJid: '' },
      ],
      settings: { humanize: false },
    }),
  );
  const targets = await config.initConfig();
  assert.deepEqual(targets[0].keywords, ['flores amarillas']);
  assert.equal(targets[0].keyword, undefined);

  const saved = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.targets[0].keywords, ['flores amarillas']);
});

test('createTarget normaliza número, grupo y palabras clave', async () => {
  await fs.rm(configFile, { force: true });
  await config.initConfig();

  const created = await config.createTarget({
    label: '  Cliente María  ',
    accountId: 'acc-1',
    targetUser: '+58 424-123.4567',
    groupJid: '1234567890-123456',
    keywords: ['  flores amarillas ', 'FLORES AMARILLAS', 'ramos', '   '],
    response: ' Yo quiero una ',
  });

  assert.equal(created.label, 'Cliente María');
  assert.equal(created.accountId, 'acc-1');
  assert.equal(created.targetUser, '584241234567');
  assert.equal(created.groupJid, '1234567890-123456@g.us');
  assert.deepEqual(created.keywords, ['flores amarillas', 'ramos']);
  assert.equal(created.response, 'Yo quiero una');
  assert.equal(created.enabled, true);

  const persisted = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(persisted.targets.length, 1);
  assert.equal(persisted.targets[0].id, created.id);
  assert.deepEqual(persisted.targets[0].keywords, ['flores amarillas', 'ramos']);
});

test('createTarget rechaza datos inválidos con detalle por campo', async () => {
  await assert.rejects(
    () => config.createTarget({ targetUser: '123', keywords: [], response: '' }),
    (error) => {
      assert.ok(Array.isArray(error.validation));
      assert.ok(error.validation.length >= 3);
      return true;
    },
  );
});

test('createTarget exige una cuenta de WhatsApp que responda', async () => {
  await assert.rejects(
    () => config.createTarget({ targetUser: '584241234567', keywords: ['x'], response: 'y' }),
    /cuenta de WhatsApp/,
  );
});

test('createTarget rechaza duplicados (número + grupo + palabra clave)', async () => {
  await assert.rejects(
    () =>
      config.createTarget({
        accountId: 'acc-1',
        targetUser: '584241234567',
        groupJid: '1234567890-123456@g.us',
        keywords: ['FLORES AMARILLAS'],
        response: 'otra',
      }),
    /Ya existe un registro/,
  );
});

test('createTarget rechaza un registro con alguna palabra clave repetida', async () => {
  await assert.rejects(
    () =>
      config.createTarget({
        accountId: 'acc-1',
        targetUser: '584241234567',
        groupJid: '1234567890-123456@g.us',
        keywords: ['ramos', 'flores amarillas'],
        response: 'otra',
      }),
    /Ya existe un registro/,
  );
});

test('createTarget permite otro grupo o palabras clave distintas', async () => {
  const second = await config.createTarget({
    label: 'Otro grupo',
    accountId: 'acc-1',
    targetUser: '584241234567',
    groupJid: '',
    keywords: ['caramelos'],
    response: 'Yo quiero caramelos',
  });
  assert.equal(second.targetUser, '584241234567');
  assert.equal(config.getTargets().length, 2);
});

test('updateTarget modifica campos y conserva id/createdAt', async () => {
  const [first] = config.getTargets();
  const updated = await config.updateTarget(first.id, { response: 'Nueva respuesta', label: 'Renombrado' });

  assert.equal(updated.id, first.id);
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal(updated.response, 'Nueva respuesta');
  assert.equal(updated.label, 'Renombrado');
});

test('updateTarget con id inexistente falla', async () => {
  await assert.rejects(() => config.updateTarget('no-existe', { response: 'x' }), /no encontrado/);
});

test('toggleTarget activa y desactiva', async () => {
  const [first] = config.getTargets();
  const disabled = await config.toggleTarget(first.id, false);
  assert.equal(disabled.enabled, false);

  const enabled = await config.toggleTarget(first.id, true);
  assert.equal(enabled.enabled, true);
});

test('deleteTarget elimina y persiste', async () => {
  const [first] = config.getTargets();
  await config.deleteTarget(first.id);

  const remaining = config.getTargets();
  assert.equal(remaining.length, 1);
  assert.notEqual(remaining[0].id, first.id);

  const persisted = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(persisted.targets.length, 1);
});

test('deleteTarget con id inexistente falla', async () => {
  await assert.rejects(() => config.deleteTarget('no-existe'), /no encontrado/);
});

test('createTargetsBulk agrega varios y reporta omitidos', async () => {
  // Estado previo: queda 1 registro (584241234567 con palabra clave "caramelos").
  const result = await config.createTargetsBulk({
    entries: [
      { targetUser: '584241111111', label: 'Ana' },
      { targetUser: '584241222222' },
      { targetUser: '584241111111' },
      { targetUser: '123' },
      { targetUser: '584241234567' },
    ],
    keywords: ['caramelos', 'dulces'],
    response: 'Yo quiero caramelos',
    groupJid: '',
    label: 'Cliente',
    accountId: 'acc-1',
  });

  assert.equal(result.created.length, 2);
  assert.equal(result.created[0].label, 'Ana');
  assert.equal(result.created[1].label, 'Cliente');
  assert.deepEqual(result.created[0].keywords, ['caramelos', 'dulces']);
  assert.equal(result.skipped.length, 3);
  assert.match(result.skipped[0].reason, /repetido/i);
  assert.match(result.skipped[1].reason, /dígitos|número/i);
  assert.match(result.skipped[2].reason, /Ya existe/i);

  assert.equal(config.getTargets().length, 3);
  const persisted = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(persisted.targets.length, 3);
});

test('createTargetsBulk valida lista vacía y comparte grupo/palabras clave', async () => {
  await assert.rejects(() => config.createTargetsBulk({ entries: [], keywords: ['x'], response: 'y' }), /al menos un número/);

  const result = await config.createTargetsBulk({
    entries: ['584999111111', '584999222222'],
    keywords: ['orquídeas'],
    response: 'Yo quiero orquídeas',
    groupJid: '1234567890-123456',
    accountId: 'acc-1',
  });
  assert.equal(result.created.length, 2);
  assert.equal(result.created[0].groupJid, '1234567890-123456@g.us');
  assert.deepEqual(result.created[1].keywords, ['orquídeas']);
});

test('los registros pertenecen a una cuenta y se eliminan con ella', async () => {
  const assigned = await config.createTarget({
    accountId: 'cuenta-1',
    targetUser: '584777111222',
    keywords: ['prueba-cuenta'],
    response: 'ok',
  });
  assert.equal(assigned.accountId, 'cuenta-1');

  const other = await config.createTarget({
    accountId: 'cuenta-2',
    targetUser: '584777333444',
    keywords: ['prueba-cuenta'],
    response: 'ok',
  });
  assert.equal(other.accountId, 'cuenta-2');

  // Al eliminar una cuenta se eliminan sus registros.
  const removed = await config.deleteTargetsByAccount('cuenta-1');
  assert.equal(removed, 1);
  assert.equal(config.getTargets().some((target) => target.id === assigned.id), false);

  // La otra cuenta conserva los suyos aunque usen la misma palabra clave.
  assert.ok(config.getTargets().some((target) => target.id === other.id));

  const noChange = await config.deleteTargetsByAccount('cuenta-1');
  assert.equal(noChange, 0);
});

test('settings: modo humano desactivado por defecto y configurable', async () => {
  await fs.rm(configFile, { force: true });
  await config.initConfig();

  assert.deepEqual(config.getSettings(), { humanize: false });

  const updated = await config.updateSettings({ humanize: true });
  assert.equal(updated.humanize, true);

  const persisted = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(persisted.settings.humanize, true);

  // El ajuste sobrevive un reinicio.
  await config.initConfig();
  assert.equal(config.getSettings().humanize, true);
});

test('createTarget acepta el formato antiguo keyword (string separado por comas)', async () => {
  await fs.rm(configFile, { force: true });
  await config.initConfig();

  const created = await config.createTarget({
    accountId: 'acc-1',
    targetUser: '584555123456',
    keyword: 'orquídeas, rosas',
    response: 'ok',
  });

  assert.deepEqual(created.keywords, ['orquídeas', 'rosas']);
});

test('la misma configuración en números distintos es válida (independientes)', async () => {
  await fs.rm(configFile, { force: true });
  await config.initConfig();

  await config.createTarget({
    accountId: 'acc-1',
    targetUser: '584241234567',
    keywords: ['flores', 'ramos'],
    response: 'Respuesta A',
  });
  const other = await config.createTarget({
    accountId: 'acc-2',
    targetUser: '584241234567',
    keywords: ['flores', 'ramos'],
    response: 'Respuesta B',
  });

  assert.equal(other.accountId, 'acc-2');
  assert.equal(other.response, 'Respuesta B');
  assert.equal(config.getTargets().length, 2);
});

test('assignUnassignedTargets asigna los registros antiguos a un número', async () => {
  await fs.rm(configFile, { force: true });
  await config.initConfig();
  await config.createTarget({
    accountId: 'acc-1',
    targetUser: '584111111111',
    keywords: ['uno'],
    response: 'ok',
  });

  // Simula un registro del formato antiguo "cualquier cuenta" en el archivo.
  const raw = JSON.parse(await fs.readFile(configFile, 'utf8'));
  raw.targets.push({
    id: 'legacy-1',
    accountId: '',
    targetUser: '584222222222',
    keywords: ['dos'],
    response: 'ok',
  });
  await fs.writeFile(configFile, JSON.stringify(raw));

  await config.initConfig();
  const assigned = await config.assignUnassignedTargets('acc-1');
  assert.equal(assigned, 1);
  assert.equal(config.getTargets().find((target) => target.id === 'legacy-1').accountId, 'acc-1');
  assert.equal(await config.assignUnassignedTargets('acc-1'), 0);
});
