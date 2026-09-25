import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { dataDir } from './config.js';
import { storeReadDoc, storeWriteDoc, usingDb } from './db.js';
import { addLog } from './logger.js';

const scrypt = promisify(scryptCallback);
const MIN_PASSWORD_LENGTH = 8;

export function credentialsPath() {
  return path.join(dataDir(), 'master.json');
}

// Si se define MASTER_KEY en el .env, la contraseña queda fijada por entorno.
export function usingEnvKey() {
  return Boolean(process.env.MASTER_KEY && process.env.MASTER_KEY.trim().length > 0);
}

// Lee el documento de la contraseña maestra. En modo nube se lee de Turso; si
// aún no existe y hay un master.json en disco, se adopta y se sube (migración).
async function readRawMaster() {
  if (usingDb()) {
    const stored = await storeReadDoc('master');
    if (stored !== null) return stored;
    let legacy;
    try {
      legacy = await fs.readFile(credentialsPath(), 'utf8');
    } catch {
      return null;
    }
    await storeWriteDoc('master', legacy);
    addLog('info', 'Contraseña maestra migrada del disco a la nube.');
    return legacy;
  }
  try {
    return await fs.readFile(credentialsPath(), 'utf8');
  } catch {
    return null;
  }
}

async function writeMaster(payload) {
  const json = JSON.stringify(payload, null, 2);
  if (usingDb()) {
    await storeWriteDoc('master', json);
    return;
  }
  await fs.mkdir(dataDir(), { recursive: true });
  const tmp = `${credentialsPath()}.tmp`;
  await fs.writeFile(tmp, json);
  await fs.rename(tmp, credentialsPath());
}

export async function hasMasterPassword() {
  if (usingEnvKey()) return true;
  return (await readRawMaster()) !== null;
}

// Primer inicio: crea la contraseña maestra hasheada con scrypt + salt aleatorio.
export async function setupMasterPassword(password) {
  if (await hasMasterPassword()) {
    throw new Error('La contraseña maestra ya está configurada.');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  await writeMaster({
    version: 1,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    createdAt: new Date().toISOString(),
  });
}

export async function verifyMasterPassword(password) {
  if (typeof password !== 'string' || password.length === 0) return false;

  if (usingEnvKey()) {
    // Se hashean ambos lados con sha256 para que timingSafeEqual reciba buffers del mismo tamaño.
    const provided = createHash('sha256').update(password).digest();
    const expected = createHash('sha256').update(process.env.MASTER_KEY.trim()).digest();
    return timingSafeEqual(provided, expected);
  }

  let payload;
  try {
    payload = JSON.parse((await readRawMaster()) ?? '');
  } catch {
    return false;
  }

  const salt = Buffer.from(payload.salt, 'base64');
  const expected = Buffer.from(payload.hash, 'base64');
  const provided = await scrypt(password, salt, expected.length);
  return timingSafeEqual(provided, expected);
}
