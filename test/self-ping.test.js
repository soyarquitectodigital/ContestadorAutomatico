import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSelfPingUrl,
  resolveIntervalMs,
  startSelfPing,
  stopSelfPing,
  DEFAULT_INTERVAL_MINUTES,
} from '../lib/self-ping.js';

test('sin URL pública no hay auto-ping', () => {
  assert.equal(resolveSelfPingUrl({}), null);
  assert.equal(resolveSelfPingUrl({ RENDER_EXTERNAL_URL: '   ' }), null);
});

test('usa SELF_PING_URL o APP_URL antes que RENDER_EXTERNAL_URL', () => {
  assert.equal(
    resolveSelfPingUrl({
      SELF_PING_URL: 'https://propio.example.com',
      APP_URL: 'https://app.example.com',
      RENDER_EXTERNAL_URL: 'https://render.onrender.com',
    }),
    'https://propio.example.com',
  );
  assert.equal(
    resolveSelfPingUrl({ APP_URL: 'https://app.example.com', RENDER_EXTERNAL_URL: 'https://render.onrender.com' }),
    'https://app.example.com',
  );
  assert.equal(
    resolveSelfPingUrl({ RENDER_EXTERNAL_URL: 'https://render.onrender.com' }),
    'https://render.onrender.com',
  );
});

test('quita espacios y barras finales y exige http(s)', () => {
  assert.equal(resolveSelfPingUrl({ SELF_PING_URL: ' https://a.onrender.com/ ' }), 'https://a.onrender.com');
  assert.equal(resolveSelfPingUrl({ SELF_PING_URL: 'a.onrender.com' }), null);
  assert.equal(resolveSelfPingUrl({ SELF_PING_URL: 'ftp://a.com' }), null);
});

test('intervalo por defecto, configurable y con mínimo de 1 minuto', () => {
  assert.equal(resolveIntervalMs({}), DEFAULT_INTERVAL_MINUTES * 60 * 1000);
  assert.equal(resolveIntervalMs({ SELF_PING_INTERVAL_MINUTES: '5' }), 5 * 60 * 1000);
  assert.equal(resolveIntervalMs({ SELF_PING_INTERVAL_MINUTES: '0' }), DEFAULT_INTERVAL_MINUTES * 60 * 1000);
  assert.equal(resolveIntervalMs({ SELF_PING_INTERVAL_MINUTES: 'abc' }), DEFAULT_INTERVAL_MINUTES * 60 * 1000);
  assert.equal(resolveIntervalMs({ SELF_PING_INTERVAL_MINUTES: '0.2' }), 60 * 1000);
});

test('startSelfPing no se activa sin URL y hace ping periódico con URL', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'], now: 0 });

  assert.equal(startSelfPing({ env: {} }), false);

  const calls = [];
  const fetchOk = async (url) => {
    calls.push(url);
    return { ok: true, status: 200 };
  };

  assert.equal(startSelfPing({ env: { RENDER_EXTERNAL_URL: 'https://x.onrender.com', SELF_PING_INTERVAL_MINUTES: '5' }, fetchImpl: fetchOk }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['https://x.onrender.com/healthz']); // ping inmediato al arrancar

  t.mock.timers.tick(5 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);

  stopSelfPing();
  t.mock.timers.tick(10 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2); // detenido: no más pings

  t.mock.timers.reset();
});
