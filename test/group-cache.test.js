import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupMetadataCache, DEFAULT_GROUP_METADATA_TTL_MS } from '../lib/group-cache.js';

test('get devuelve undefined si no existe o no tiene participantes', () => {
  const cache = createGroupMetadataCache();
  assert.equal(cache.get('x@g.us'), undefined);

  cache.set({ id: 'x@g.us', subject: 'Sin participantes' });
  assert.equal(cache.get('x@g.us'), undefined);
});

test('set y get devuelven los metadatos completos', () => {
  const cache = createGroupMetadataCache();
  const meta = { id: 'g@g.us', subject: 'Grupo', participants: [{ id: 'a@s.whatsapp.net' }] };
  cache.set(meta);

  assert.deepEqual(cache.get('g@g.us'), meta);
  assert.equal(cache.size(), 1);
});

test('merge conserva los campos previos ante actualizaciones parciales', () => {
  const cache = createGroupMetadataCache();
  cache.set({ id: 'g@g.us', subject: 'Antes', participants: [{ id: 'a' }] });

  cache.merge([{ id: 'g@g.us', subject: 'Después' }]);

  const meta = cache.get('g@g.us');
  assert.equal(meta.subject, 'Después');
  assert.deepEqual(meta.participants, [{ id: 'a' }]);
});

test('invalidate y clear vacían el cache', () => {
  const cache = createGroupMetadataCache();
  cache.set({ id: 'a@g.us', participants: [] });
  cache.set({ id: 'b@g.us', participants: [] });

  cache.invalidate('a@g.us');
  assert.equal(cache.get('a@g.us'), undefined);
  assert.equal(cache.size(), 1);

  cache.clear();
  assert.equal(cache.size(), 0);
});

test('get descarta las entradas vencidas según el TTL', () => {
  let current = 0;
  const cache = createGroupMetadataCache({ ttlMs: 1000, now: () => current });
  cache.set({ id: 'g@g.us', participants: [] });
  assert.ok(cache.get('g@g.us'));

  current = 1001;
  assert.equal(cache.get('g@g.us'), undefined);
});

test('el TTL por defecto es de 12 horas', () => {
  assert.equal(DEFAULT_GROUP_METADATA_TTL_MS, 12 * 60 * 60 * 1000);
});

test('peek consulta sin borrar ni alterar y respeta el TTL', () => {
  let current = 0;
  const cache = createGroupMetadataCache({ ttlMs: 1000, now: () => current });
  assert.equal(cache.peek('g@g.us'), false);

  cache.set({ id: 'g@g.us', participants: [{ id: 'a' }] });
  assert.equal(cache.peek('g@g.us'), true);
  assert.equal(cache.size(), 1);

  current = 1001;
  assert.equal(cache.peek('g@g.us'), false);
  assert.equal(cache.size(), 1, 'peek no debe borrar la entrada vencida');
});

test('getOrFetch consulta una sola vez y guarda el resultado', async () => {
  const cache = createGroupMetadataCache();
  const meta = { id: 'g@g.us', participants: [{ id: 'a' }] };
  let calls = 0;

  const first = await cache.getOrFetch('g@g.us', async () => {
    calls += 1;
    return meta;
  });
  assert.deepEqual(first, meta);
  assert.equal(calls, 1);
  assert.deepEqual(cache.get('g@g.us'), meta);

  const second = await cache.getOrFetch('g@g.us', async () => {
    calls += 1;
    return { ...meta, subject: 'otro' };
  });
  assert.deepEqual(second, meta);
  assert.equal(calls, 1, 'la segunda vez debe salir del caché');
});

test('getOrFetch vuelve a consultar cuando el TTL venció', async () => {
  let current = 0;
  const cache = createGroupMetadataCache({ ttlMs: 1000, now: () => current });
  const meta = { id: 'g@g.us', participants: [] };
  let calls = 0;

  await cache.getOrFetch('g@g.us', async () => {
    calls += 1;
    return meta;
  });
  assert.equal(calls, 1);

  current = 1001;
  const refreshed = await cache.getOrFetch('g@g.us', async () => {
    calls += 1;
    return { ...meta, subject: 'nuevo' };
  });
  assert.equal(calls, 2);
  assert.equal(refreshed.subject, 'nuevo');
  assert.equal(cache.get('g@g.us').subject, 'nuevo');
});

test('getOrFetch no guarda nada si el fetcher falla o devuelve vacío', async () => {
  const cache = createGroupMetadataCache();

  await assert.rejects(
    cache.getOrFetch('g@g.us', async () => {
      throw new Error('red');
    }),
    /red/,
  );
  assert.equal(cache.get('g@g.us'), undefined);

  assert.equal(await cache.getOrFetch('g@g.us', async () => undefined), undefined);
  assert.equal(cache.size(), 0);
});
