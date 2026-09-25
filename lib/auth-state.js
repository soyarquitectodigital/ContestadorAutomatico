// Estado de autenticación de Baileys persistido en Turso (modo DB).
//
// Sustituye a useMultiFileAuthState cuando TURSO_DATABASE_URL está configurada.
// Es compatible con el formato de archivos: las claves se guardan con el mismo
// nombre que Baileys da a los archivos ('creds', 'session-...', 'pre-key-...',
// 'app-state-sync-key-...'), incluido su fixFileName, así la importación de una
// carpeta auth_info existente es una copia literal.
//
// Rendimiento: las claves Signal rotan con cada mensaje y Baileys hace await de
// keys.set en pleno procesamiento, así que las escrituras a la red NO se
// esperan: la caché en memoria es la fuente de verdad inmediata y la escritura
// va encolada en segundo plano (con reintento y flush al cerrar el proceso).

import { BufferJSON, initAuthCreds, proto } from 'baileys';
import { authDeleteAccount, authEnqueueWrite, authReadRows } from './db.js';

// Mismo mapeo que el fixFileName de useMultiFileAuthState (sin la extensión).
const fixKey = (name) => name?.replace(/\//g, '__')?.replace(/:/g, '-');

// Cachés vivas por cuenta, para invalidarlas al borrar la sesión.
const cachesByAccount = new Map();

export async function useDbAuthState(accountId) {
  const cache = new Map(); // 'tipo-id' -> valor ya parseado (null = borrada/inexistente)
  if (!cachesByAccount.has(accountId)) cachesByAccount.set(accountId, new Set());
  cachesByAccount.get(accountId).add(cache);

  const credsRows = await authReadRows(accountId, ['creds']);
  const creds = credsRows.has('creds') ? JSON.parse(credsRows.get('creds'), BufferJSON.reviver) : initAuthCreds();

  const keys = {
    get: async (type, ids) => {
      const data = {};
      const missing = [];
      for (const id of ids) {
        if (cache.has(`${type}-${id}`)) {
          data[id] = cache.get(`${type}-${id}`);
        } else {
          missing.push(id);
        }
      }

      if (missing.length > 0) {
        const rows = await authReadRows(accountId, missing.map((id) => fixKey(`${type}-${id}`)));
        for (const id of missing) {
          const raw = rows.get(fixKey(`${type}-${id}`));
          let value = raw != null ? JSON.parse(raw, BufferJSON.reviver) : null;
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          cache.set(`${type}-${id}`, value);
          data[id] = value;
        }
      }

      return data;
    },

    set: async (data) => {
      const ops = [];
      for (const category in data) {
        for (const id in data[category]) {
          const value = data[category][id];
          cache.set(`${category}-${id}`, value ?? null);
          ops.push({
            key: fixKey(`${category}-${id}`),
            value: value ? JSON.stringify(value, BufferJSON.replacer) : null,
          });
        }
      }
      // Sin await: la escritura remota va en segundo plano.
      void authEnqueueWrite(accountId, ops);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: () => authEnqueueWrite(accountId, [{ key: 'creds', value: JSON.stringify(creds, BufferJSON.replacer) }]),
  };
}

// Borra la sesión de la cuenta en la nube e invalida sus cachés en memoria.
export async function clearDbAuthState(accountId) {
  for (const cache of cachesByAccount.get(accountId) ?? []) cache.clear();
  cachesByAccount.delete(accountId);
  await authDeleteAccount(accountId);
}
