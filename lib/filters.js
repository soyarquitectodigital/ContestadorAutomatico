// Lógica de filtrado pura (sin dependencias de Baileys) para poder testearla aislada.

export const IGNORE_REASONS = {
  'sin-contenido': 'El mensaje no tiene contenido procesable',
  'mensaje-propio': 'El mensaje lo envió el propio bot',
  'no-grupo': 'No proviene de un grupo',
  'otro-grupo': 'Proviene de un grupo distinto al registrado',
  'usuario-no-objetivo': 'El autor no está registrado',
  'sin-texto': 'No se pudo extraer texto del mensaje',
  'sin-palabra-clave': 'No contiene la palabra clave',
  'registro-desactivado': 'El registro coincide pero está desactivado',
};

export function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

export function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

// Extrae el texto de los tipos de mensaje habituales, incluyendo los
// contenedores (efímeros, ver una vez, documento con pie de foto...).
export function extractText(message) {
  if (!message || typeof message !== 'object') return '';

  const wrappers = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
  ];
  for (const key of wrappers) {
    if (message[key]?.message) return extractText(message[key].message);
  }

  if (typeof message.conversation === 'string') return message.conversation;
  if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;

  const captions = [
    message.imageMessage?.caption,
    message.videoMessage?.caption,
    message.documentMessage?.caption,
  ];
  for (const caption of captions) {
    if (typeof caption === 'string' && caption.trim()) return caption;
  }

  if (typeof message.buttonsResponseMessage?.selectedDisplayText === 'string') {
    return message.buttonsResponseMessage.selectedDisplayText;
  }
  if (typeof message.listResponseMessage?.title === 'string') return message.listResponseMessage.title;
  if (typeof message.templateButtonReplyMessage?.selectedDisplayText === 'string') {
    return message.templateButtonReplyMessage.selectedDisplayText;
  }

  return '';
}

// Normaliza texto: minúsculas, sin acentos y con espacios colapsados.
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function containsKeyword(text, keyword) {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) return false;
  return normalizeText(text).includes(normalizedKeyword);
}

// Filtro 2: el autor debe coincidir con el usuario objetivo.
// Se comparan solo los dígitos y se revisan `participant` y `participantAlt`
// porque Baileys v7 puede entregar el autor como JID @lid en lugar de @s.whatsapp.net.
export function matchesTargetUser(key, targetUser) {
  const target = digitsOnly(targetUser);
  if (!target) return false;
  const candidates = [key?.participant, key?.participantAlt, key?.participantPn]
    .map(digitsOnly)
    .filter(Boolean);
  return candidates.some((candidate) => candidate === target);
}

// Describe al autor para los registros: teléfono real si está disponible y,
// cuando WhatsApp lo entrega con @lid, se muestra también ese identificador.
export function describeAuthor(key) {
  const jids = [key?.participant, key?.participantAlt, key?.participantPn].filter(Boolean);
  const phone = jids.find((jid) => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us'));
  const lid = jids.find((jid) => jid.endsWith('@lid'));

  if (phone && lid) {
    const phoneDigits = digitsOnly(phone);
    const lidDigits = digitsOnly(lid);
    if (phoneDigits !== lidDigits) return `+${phoneDigits} (lid ${lidDigits})`;
  }
  if (phone) return `+${digitsOnly(phone)}`;
  if (lid) return `lid ${digitsOnly(lid)}`;
  const fallback = digitsOnly(jids[0]);
  return fallback ? `+${fallback}` : 'desconocido';
}

// Evalúa los filtros para una lista de registros (CRUD de números).
// Devuelve el registro que debe responder y el motivo cuando no hay coincidencia.
export function evaluateMessage(message, targets = []) {
  // Filtro base: contenido procesable y que no sea un mensaje del propio bot.
  if (!message?.message) return { pass: false, reason: 'sin-contenido' };
  if (message.key?.fromMe) return { pass: false, reason: 'mensaje-propio' };

  // Filtro 1: solo grupos.
  if (!isGroupJid(message.key?.remoteJid)) return { pass: false, reason: 'no-grupo' };

  // Filtro 2: el autor debe estar registrado (comparación por dígitos).
  const authorMatches = targets.filter((target) => matchesTargetUser(message.key, target.targetUser));
  if (authorMatches.length === 0) return { pass: false, reason: 'usuario-no-objetivo' };

  // Filtro 3: debe contener la palabra clave de alguno de sus registros.
  const text = extractText(message.message);
  if (!text.trim()) return { pass: false, reason: 'sin-texto' };
  const keywordMatches = authorMatches.filter((target) => containsKeyword(text, target.keyword));
  if (keywordMatches.length === 0) return { pass: false, reason: 'sin-palabra-clave' };

  // Filtro 4: el grupo debe coincidir cuando el registro lo restringe.
  const groupMatches = keywordMatches.filter(
    (target) => !target.groupJid || target.groupJid === message.key.remoteJid,
  );
  if (groupMatches.length === 0) return { pass: false, reason: 'otro-grupo' };

  // Filtro 5: el registro debe estar activo.
  const enabledMatches = groupMatches.filter((target) => target.enabled !== false);
  if (enabledMatches.length === 0) return { pass: false, reason: 'registro-desactivado' };

  return { pass: true, reason: 'ok', text, target: enabledMatches[0] };
}

// Indica si el texto contiene la palabra clave de algún registro del autor.
export function containsAnyKeyword(text, targets) {
  return targets.some((target) => containsKeyword(text, target.keyword));
}
