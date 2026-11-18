import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize } from '../lib/metrics.js';

test('percentile calcula p50 y p95 sobre valores ordenados', () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([], 50), null);
});

test('summarize devuelve conteo, p50, p95, promedio y máximo', () => {
  assert.deepEqual(summarize([10, 20, 30, 40]), {
    count: 4,
    p50: 20,
    p95: 40,
    avg: 25,
    max: 40,
  });
});

test('summarize ignora nulos, no numéricos y negativos', () => {
  assert.deepEqual(summarize([null, undefined, 'x', -5, 10, 20]), {
    count: 2,
    p50: 10,
    p95: 20,
    avg: 15,
    max: 20,
  });
  assert.deepEqual(summarize([]), { count: 0, p50: null, p95: null, avg: null, max: null });
});
