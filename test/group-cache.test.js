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

test('el TTL por defecto es de 15 minutos', () => {
  assert.equal(DEFAULT_GROUP_METADATA_TTL_MS, 15 * 60 * 1000);
});
