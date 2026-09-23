import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const CONFIG_VERSION = 2;
const DEFAULT_SETTINGS = { humanize: false };
const DEFAULTS = { version: CONFIG_VERSION, targets: [], settings: { ...DEFAULT_SETTINGS } };

let cache = structuredClone(DEFAULTS);

// Carpeta de datos: config.json y auth_info (sesión de WhatsApp).
// En Docker se sobrescribe con DATA_DIR=/app/data, montado como volumen.
export function dataDir() {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), 'data');
}

export function configPath() {
  return path.join(dataDir(), 'config.json');
}

export function normalizeTargetUser(value) {
  return String(value ?? '').replace(/\D/g, '').slice(0, 15);
}

export function normalizeGroupJid(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (/^[\d-]+@g\.us$/.test(raw)) return raw;
  if (/^[\d-]+$/.test(raw)) return `${raw}@g.us`;
  return raw;
}

function sanitizeTarget(raw = {}) {
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
    label: String(raw.label ?? '').trim().slice(0, 60),
    targetUser: normalizeTargetUser(raw.targetUser),
    keyword: String(raw.keyword ?? '').trim(),
    response: String(raw.response ?? '').trim(),
    groupJid: normalizeGroupJid(raw.groupJid),
    // Cuenta de WhatsApp que responde: '' = cualquiera de las cuentas conectadas.
    accountId: typeof raw.accountId === 'string' ? raw.accountId : '',
    enabled: raw.enabled !== false,
    createdAt: raw.createdAt ?? new Date().toISOString(),
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  };
}

export function validateTarget(target) {
  const errors = [];
  if (!target.targetUser) {
    errors.push('Falta el número de WhatsApp.');
  } else if (!/^\d{8,15}$/.test(target.targetUser)) {
    errors.push('El número debe tener entre 8 y 15 dígitos, con código de país y sin "+".');
  }
  if (!target.keyword) errors.push('Falta la palabra clave.');
  if (!target.response) errors.push('Falta el texto de la respuesta.');
  if (target.groupJid && !/^[\d-]+@g\.us$/.test(target.groupJid)) {
    errors.push('El JID del grupo no es válido. Ejemplo: 1234567890-123456@g.us');
  }
  return errors;
}

function throwValidation(errors) {
  const error = new Error(errors.join(' '));
  error.validation = errors;
  throw error;
}

function assertNoDuplicate(targets, candidate, ignoreId) {
  const duplicate = targets.find(
    (target) =>
      target.id !== ignoreId &&
      target.targetUser === candidate.targetUser &&
      target.keyword.toLowerCase() === candidate.keyword.toLowerCase() &&
      target.groupJid === candidate.groupJid,
  );
  if (duplicate) {
    throwValidation(['Ya existe un registro con ese número, grupo y palabra clave.']);
  }
}

async function persist() {
  await fs.mkdir(dataDir(), { recursive: true });
  // Escritura atómica: se escribe un temporal y luego se renombra.
  const tmp = `${configPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, configPath());
}

export function sanitizeSettings(raw = {}) {
  return {
    humanize: Boolean(raw?.humanize),
  };
}

export async function initConfig() {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(), 'utf8'));

    if (Array.isArray(raw.targets)) {
      cache = {
        version: CONFIG_VERSION,
        targets: raw.targets.map(sanitizeTarget),
        settings: sanitizeSettings(raw.settings),
      };
    } else if (raw.targetUser || raw.keyword || raw.response || raw.groupJid) {
      // Migración del formato antiguo (un solo registro) al nuevo CRUD.
      cache = {
        version: CONFIG_VERSION,
        targets: [sanitizeTarget({ label: 'Principal', ...raw })],
        settings: { ...DEFAULT_SETTINGS },
      };
      await persist();
    } else {
      cache = structuredClone(DEFAULTS);
    }
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return getTargets();
}

// Ajustes generales: humanize = true activa la secuencia anti-baneo.
export function getSettings() {
  return { ...cache.settings };
}

export async function updateSettings(partial = {}) {
  cache.settings = sanitizeSettings({ ...cache.settings, ...partial });
  await persist();
  return getSettings();
}

export function getTargets() {
  return cache.targets.map((target) => ({ ...target }));
}

export async function createTarget(raw) {
  const target = sanitizeTarget(raw);
  const errors = validateTarget(target);
  if (errors.length > 0) throwValidation(errors);
  assertNoDuplicate(cache.targets, target);

  target.createdAt = new Date().toISOString();
  target.updatedAt = target.createdAt;
  cache.targets.push(target);
  await persist();
  return { ...target };
}

export async function createTargetsBulk({ entries = [], keyword, response, groupJid = '', label = '', accountId = '' }) {
  const BULK_LIMIT = 200;
  if (!Array.isArray(entries) || entries.length === 0) {
    throwValidation(['Agrega al menos un número a la lista.']);
  }
  if (entries.length > BULK_LIMIT) {
    throwValidation([`Máximo ${BULK_LIMIT} números por carga.`]);
  }

  const baseLabel = String(label ?? '').trim().slice(0, 60);
  const created = [];
  const skipped = [];
  const seen = new Set();

  for (const rawEntry of entries) {
    const entry = typeof rawEntry === 'string' ? { targetUser: rawEntry } : rawEntry ?? {};
    const candidate = sanitizeTarget({
      label: entry.label ? entry.label : baseLabel,
      targetUser: entry.targetUser ?? entry.number,
      keyword,
      response,
      groupJid,
      accountId,
    });

    const errors = validateTarget(candidate);
    if (errors.length > 0) {
      skipped.push({ input: String(entry.targetUser ?? entry.number ?? ''), reason: errors[0] });
      continue;
    }

    const key = `${candidate.targetUser}|${candidate.keyword.toLowerCase()}|${candidate.groupJid}`;
    if (seen.has(key)) {
      skipped.push({ input: candidate.targetUser, reason: 'Número repetido en la lista.' });
      continue;
    }

    const duplicate = cache.targets.find(
      (target) =>
        target.targetUser === candidate.targetUser &&
        target.keyword.toLowerCase() === candidate.keyword.toLowerCase() &&
        target.groupJid === candidate.groupJid,
    );
    if (duplicate) {
      skipped.push({ input: candidate.targetUser, reason: 'Ya existe un registro con ese número, grupo y palabra clave.' });
      continue;
    }

    seen.add(key);
    candidate.createdAt = new Date().toISOString();
    candidate.updatedAt = candidate.createdAt;
    created.push(candidate);
  }

  if (created.length > 0) {
    cache.targets.push(...created);
    await persist();
  }

  return { created: created.map((target) => ({ ...target })), skipped };
}

export async function updateTarget(id, raw) {
  const index = cache.targets.findIndex((target) => target.id === id);
  if (index === -1) throw new Error('Registro no encontrado.');

  const current = cache.targets[index];
  const target = sanitizeTarget({
    ...current,
    ...raw,
    id,
    createdAt: current.createdAt,
  });
  const errors = validateTarget(target);
  if (errors.length > 0) throwValidation(errors);
  assertNoDuplicate(cache.targets, target, id);

  target.updatedAt = new Date().toISOString();
  cache.targets[index] = target;
  await persist();
  return { ...target };
}

export async function deleteTarget(id) {
  const before = cache.targets.length;
  cache.targets = cache.targets.filter((target) => target.id !== id);
  if (cache.targets.length === before) throw new Error('Registro no encontrado.');
  await persist();
}

export async function toggleTarget(id, enabled) {
  const target = cache.targets.find((item) => item.id === id);
  if (!target) throw new Error('Registro no encontrado.');
  target.enabled = Boolean(enabled);
  target.updatedAt = new Date().toISOString();
  await persist();
  return { ...target };
}

// Al eliminar una cuenta de WhatsApp, sus registros pasan a "cualquier cuenta".
export async function clearAccountFromTargets(accountId) {
  let changed = false;
  cache.targets = cache.targets.map((target) => {
    if (target.accountId !== accountId) return target;
    changed = true;
    return { ...target, accountId: '', updatedAt: new Date().toISOString() };
  });
  if (changed) await persist();
  return changed;
}
