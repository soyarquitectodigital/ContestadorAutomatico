import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { dataDir } from './config.js';

const scrypt = promisify(scryptCallback);
const MIN_PASSWORD_LENGTH = 8;

export function credentialsPath() {
  return path.join(dataDir(), 'master.json');
}

// Si se define MASTER_KEY en el .env, la contraseña queda fijada por entorno.
export function usingEnvKey() {
  return Boolean(process.env.MASTER_KEY && process.env.MASTER_KEY.trim().length > 0);
}

export async function hasMasterPassword() {
  if (usingEnvKey()) return true;
  try {
    await fs.access(credentialsPath());
    return true;
  } catch {
    return false;
  }
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
  const payload = {
    version: 1,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(dataDir(), { recursive: true });
  const tmp = `${credentialsPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
  await fs.rename(tmp, credentialsPath());
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
    payload = JSON.parse(await fs.readFile(credentialsPath(), 'utf8'));
  } catch {
    return false;
  }

  const salt = Buffer.from(payload.salt, 'base64');
  const expected = Buffer.from(payload.hash, 'base64');
  const provided = await scrypt(password, salt, expected.length);
  return timingSafeEqual(provided, expected);
}
