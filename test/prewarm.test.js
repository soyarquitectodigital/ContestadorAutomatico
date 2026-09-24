import test from 'node:test';
import assert from 'node:assert/strict';
import { groupsToPrewarm, DEFAULT_MAX_PREWARM_GROUPS } from '../lib/prewarm.js';

const target = (overrides = {}) => ({
  accountId: 'acc-1',
  groupJid: '1111111111-111111@g.us',
  enabled: true,
  ...overrides,
});

test('solo incluye registros de la cuenta indicada', () => {
  const groups = groupsToPrewarm(
    [target({ groupJid: 'a@g.us' }), target({ groupJid: 'b@g.us', accountId: 'acc-2' })],
    'acc-1',
  );
  assert.deepEqual(groups, ['a@g.us']);
});

test('ignora registros desactivados o sin grupo', () => {
  const groups = groupsToPrewarm(
    [
      target({ groupJid: 'a@g.us', enabled: false }),
      target({ groupJid: '' }),
      target({ groupJid: 'b@g.us' }),
    ],
    'acc-1',
  );
  assert.deepEqual(groups, ['b@g.us']);
});

test('deduplica grupos y respeta el máximo', () => {
  const groups = groupsToPrewarm(
    [
      target({ groupJid: 'a@g.us' }),
      target({ groupJid: 'a@g.us' }),
      target({ groupJid: 'b@g.us' }),
      target({ groupJid: 'c@g.us' }),
    ],
    'acc-1',
    2,
  );
  assert.deepEqual(groups, ['a@g.us', 'b@g.us']);
});

test('el máximo por defecto es 10', () => {
  assert.equal(DEFAULT_MAX_PREWARM_GROUPS, 10);
});
