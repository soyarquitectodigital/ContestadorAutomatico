import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatQueues, QueueFullError, DEFAULT_MAX_PENDING_PER_CHAT } from '../lib/chat-queue.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('las tareas del mismo chat se ejecutan en orden y una tras otra', async () => {
  const queue = createChatQueues();
  const events = [];
  const gate = deferred();

  const first = queue.run('chat', async () => {
    events.push('inicio1');
    await gate.promise;
    events.push('fin1');
  });
  const second = queue.run('chat', async () => {
    events.push('inicio2');
    events.push('fin2');
  });

  assert.equal(queue.isBusy('chat'), true);
  assert.equal(queue.pendingCount('chat'), 1);
  assert.deepEqual(events, ['inicio1']);

  gate.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(events, ['inicio1', 'fin1', 'inicio2', 'fin2']);
  assert.equal(queue.isBusy('chat'), false);
});

test('chats distintos avanzan en paralelo', async () => {
  const queue = createChatQueues();
  const a = deferred();
  const b = deferred();

  const first = queue.run('chat-a', () => a.promise);
  const second = queue.run('chat-b', () => b.promise);

  assert.equal(queue.isBusy('chat-a'), true);
  assert.equal(queue.isBusy('chat-b'), true);

  a.resolve('a');
  b.resolve('b');
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
});

test('rechaza con QueueFullError al superar maxPending', async () => {
  const queue = createChatQueues({ maxPending: 1 });
  const gate = deferred();

  const first = queue.run('chat', () => gate.promise);
  const second = queue.run('chat', () => 'dos');

  await assert.rejects(
    () => queue.run('chat', () => 'tres'),
    (error) => error instanceof QueueFullError && error.code === 'QUEUE_FULL',
  );

  gate.resolve('uno');
  assert.deepEqual(await Promise.all([first, second]), ['uno', 'dos']);
});

test('una tarea que falla no bloquea las siguientes', async () => {
  const queue = createChatQueues();

  await assert.rejects(() => queue.run('chat', async () => {
    throw new Error('boom');
  }), /boom/);

  assert.equal(await queue.run('chat', async () => 'ok'), 'ok');
  assert.equal(queue.isBusy('chat'), false);
});

test('el límite por defecto es 3 pendientes por chat', () => {
  assert.equal(DEFAULT_MAX_PENDING_PER_CHAT, 3);
});
