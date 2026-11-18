// Cache de metadatos de grupo (lógica pura, sin dependencias de Baileys).
//
// Baileys pide los metadatos del grupo por red antes de cada envío a un grupo
// (ver relayMessage en messages-send.js). Con este cache se responde desde
// memoria y solo se consulta a WhatsApp cuando el dato venció o falta.
// Los metadatos de un grupo cambian muy poco (nombre, descripción, participantes).
// Antes el TTL era de 15 minutos y, al vencer, Baileys consultaba el grupo por red
// en CADA envío porque el resultado no se volvía a guardar. En una carrera eso
// añadía ~250-300 ms por respuesta. Ahora se conservan 12 h: los cambios reales
// llegan por los eventos groups.update / group-participants.update (que invalidan
// o fusionan la entrada) y al reconectar se limpia el caché.
export const DEFAULT_GROUP_METADATA_TTL_MS = 12 * 60 * 60 * 1000;

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

  // Consulta sin contar ni borrar: sirve para etiquetar una respuesta como
  // "caché" o "red" en las métricas sin alterar el comportamiento del caché.
  function peek(jid) {
    const entry = entries.get(jid);
    if (!entry) return false;
    if (now() - entry.updatedAt > ttlMs) return false;
    return Array.isArray(entry.data?.participants);
  }

  // Devuelve la entrada vigente o la obtiene con `fetcher` y la guarda. Es la
  // pieza que evita que un TTL vencido castigue a todos los envíos siguientes.
  async function getOrFetch(jid, fetcher) {
    const cached = get(jid);
    if (cached) return cached;

    const data = await fetcher(jid);
    if (data) set(data);
    return data;
  }

  return { get, set, merge, invalidate, clear, size, peek, getOrFetch };
}
