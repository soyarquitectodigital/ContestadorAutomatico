// Cache de metadatos de grupo (lógica pura, sin dependencias de Baileys).
//
// Baileys pide los metadatos del grupo por red antes de cada envío a un grupo
// (ver relayMessage en messages-send.js). Con este cache se responde desde
// memoria y solo se consulta a WhatsApp cuando el dato venció o falta.
export const DEFAULT_GROUP_METADATA_TTL_MS = 15 * 60 * 1000;

export function createGroupMetadataCache({ ttlMs = DEFAULT_GROUP_METADATA_TTL_MS, now = Date.now } = {}) {
  const entries = new Map(); // jid -> { data, updatedAt }

  function get(jid) {
    const entry = entries.get(jid);
    if (!entry) return undefined;
    if (now() - entry.updatedAt > ttlMs) {
      entries.delete(jid);
      return undefined;
    }
    // Sin participantes no sirve para enviar: mejor que Baileys lo consulte.
    if (!Array.isArray(entry.data?.participants)) return undefined;
    return entry.data;
  }

  function set(metadata) {
    if (!metadata?.id) return;
    entries.set(metadata.id, { data: { ...metadata }, updatedAt: now() });
  }

  // `groups.update` entrega metadatos parciales: se fusionan con lo existente.
  function merge(metadatas = []) {
    for (const metadata of metadatas) {
      if (!metadata?.id) continue;
      const previous = entries.get(metadata.id)?.data;
      entries.set(metadata.id, { data: { ...previous, ...metadata }, updatedAt: now() });
    }
  }

  function invalidate(jid) {
    entries.delete(jid);
  }

  function clear() {
    entries.clear();
  }

  function size() {
    return entries.size;
  }

  return { get, set, merge, invalidate, clear, size };
}
