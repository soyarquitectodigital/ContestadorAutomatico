import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsAnyKeyword,
  containsKeyword,
  digitsOnly,
  evaluateMessage,
  extractText,
  isGroupJid,
  matchesTargetUser,
} from '../lib/filters.js';

const TARGET_BASE = {
  id: 't1',
  label: 'Cliente',
  targetUser: '584241234567',
  keyword: 'flores amarillas',
  response: 'Yo quiero una',
  groupJid: '',
  enabled: true,
};

function buildMessage({
  remoteJid = '1234567890-123456@g.us',
  participant = '584241234567@s.whatsapp.net',
  participantAlt,
  fromMe = false,
  text = 'Hola',
  message,
} = {}) {
  return {
    key: { id: `msg-${Math.random()}`, remoteJid, participant, participantAlt, fromMe },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: message ?? { conversation: text },
  };
}

test('Filtro 1: solo acepta grupos (@g.us)', () => {
  assert.equal(isGroupJid('1234567890-123456@g.us'), true);
  assert.equal(isGroupJid('584241234567@s.whatsapp.net'), false);
  assert.equal(isGroupJid(undefined), false);

  const inGroup = evaluateMessage(buildMessage({ text: 'flores amarillas' }), [TARGET_BASE]);
  assert.equal(inGroup.pass, true);

  const inPrivate = evaluateMessage(
    buildMessage({ remoteJid: '584241234567@s.whatsapp.net', text: 'flores amarillas' }),
    [TARGET_BASE],
  );
  assert.equal(inPrivate.pass, false);
  assert.equal(inPrivate.reason, 'no-grupo');
});

test('Filtro 2: solo números registrados (comparación por dígitos)', () => {
  assert.equal(matchesTargetUser({ participant: '584241234567@s.whatsapp.net' }, '584241234567'), true);
  assert.equal(matchesTargetUser({ participant: '584999999999@s.whatsapp.net' }, '584241234567'), false);
  assert.equal(digitsOnly('+58 424-123.4567'), '584241234567');

  const result = evaluateMessage(
    buildMessage({ participant: '584999999999@s.whatsapp.net', text: 'flores amarillas' }),
    [TARGET_BASE],
  );
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'usuario-no-objetivo');
});

test('Filtro 2: soporta JIDs @lid usando participantAlt', () => {
  const key = { participant: '123456789012345@lid', participantAlt: '584241234567@s.whatsapp.net' };
  assert.equal(matchesTargetUser(key, '584241234567'), true);
  assert.equal(matchesTargetUser(key, '584999999999'), false);
});

test('Filtro 3: palabra clave sin distinguir mayúsculas ni acentos', () => {
  assert.equal(containsKeyword('Hola FLORES amarillas por favor', 'flores amarillas'), true);
  assert.equal(containsKeyword('flóres   AMARILLAS', 'flores amarillas'), true);
  assert.equal(containsKeyword('solo flores', 'flores amarillas'), false);

  const result = evaluateMessage(buildMessage({ text: 'buenos días' }), [TARGET_BASE]);
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'sin-palabra-clave');
});

test('Filtro 4: grupo restringido por registro', () => {
  const target = { ...TARGET_BASE, id: 't2', groupJid: '1111111111-111111@g.us' };

  const otherGroup = evaluateMessage(buildMessage({ text: 'flores amarillas' }), [target]);
  assert.equal(otherGroup.pass, false);
  assert.equal(otherGroup.reason, 'otro-grupo');

  const sameGroup = evaluateMessage(
    buildMessage({ remoteJid: '1111111111-111111@g.us', text: 'flores amarillas' }),
    [target],
  );
  assert.equal(sameGroup.pass, true);
  assert.equal(sameGroup.target.id, 't2');
});

test('Filtro 5: registro desactivado no responde', () => {
  const target = { ...TARGET_BASE, enabled: false };
  const result = evaluateMessage(buildMessage({ text: 'flores amarillas' }), [target]);
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'registro-desactivado');
});

test('Varios registros: responde el que coincide por número y palabra clave', () => {
  const targets = [
    { ...TARGET_BASE, id: 'a', targetUser: '584241234567', keyword: 'flores amarillas', response: 'A' },
    { ...TARGET_BASE, id: 'b', targetUser: '584241234567', keyword: 'caramelos', response: 'B' },
    { ...TARGET_BASE, id: 'c', targetUser: '584111111111', keyword: 'flores amarillas', response: 'C' },
  ];

  const first = evaluateMessage(buildMessage({ text: 'quiero flores amarillas' }), targets);
  assert.equal(first.pass, true);
  assert.equal(first.target.id, 'a');

  const second = evaluateMessage(buildMessage({ text: 'y caramelos?' }), targets);
  assert.equal(second.target.id, 'b');

  const third = evaluateMessage(
    buildMessage({ participant: '584111111111@s.whatsapp.net', text: 'flores amarillas' }),
    targets,
  );
  assert.equal(third.target.id, 'c');
});

test('containsAnyKeyword detecta palabras clave de cualquier registro', () => {
  const targets = [TARGET_BASE, { ...TARGET_BASE, id: 'x', keyword: 'caramelos' }];
  assert.equal(containsAnyKeyword('dame caramelos', targets), true);
  assert.equal(containsAnyKeyword('nada de eso', targets), false);
});

test('Extracción de texto: conversation, extended, contenedores y captions', () => {
  assert.equal(extractText({ conversation: 'hola' }), 'hola');
  assert.equal(extractText({ extendedTextMessage: { text: 'hola extendido' } }), 'hola extendido');
  assert.equal(extractText({ ephemeralMessage: { message: { conversation: 'flores amarillas' } } }), 'flores amarillas');
  assert.equal(extractText({ viewOnceMessageV2: { message: { extendedTextMessage: { text: 'oculto' } } } }), 'oculto');
  assert.equal(extractText({ imageMessage: { caption: 'mira esto flores amarillas' } }), 'mira esto flores amarillas');
  assert.equal(extractText({ documentMessage: { caption: 'doc' } }), 'doc');
  assert.equal(extractText({ stickerMessage: {} }), '');
});

test('Mensajes ignorados: sin contenido, propios y sin texto', () => {
  assert.equal(evaluateMessage({ key: { remoteJid: '1@g.us' } }, [TARGET_BASE]).reason, 'sin-contenido');
  assert.equal(evaluateMessage(buildMessage({ fromMe: true }), [TARGET_BASE]).reason, 'mensaje-propio');
  assert.equal(evaluateMessage(buildMessage({ message: { stickerMessage: {} } }), [TARGET_BASE]).reason, 'sin-texto');
});

test('Flujo completo: devuelve el registro y el texto', () => {
  const message = buildMessage({ text: 'Chamo, ¿y las flores amarillas?' });
  const result = evaluateMessage(message, [TARGET_BASE]);
  assert.equal(result.pass, true);
  assert.equal(result.reason, 'ok');
  assert.equal(result.text, 'Chamo, ¿y las flores amarillas?');
  assert.equal(result.target.response, 'Yo quiero una');
});

test('Sin registros configurados no pasa nada', () => {
  const result = evaluateMessage(buildMessage({ text: 'flores amarillas' }), []);
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'usuario-no-objetivo');
});
