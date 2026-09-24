// Selección de grupos a precalentar por cuenta (lógica pura, sin Baileys).
//
// Precalentar un grupo significa dejar listos en memoria los dispositivos de
// sus participantes y las sesiones Signal, que Baileys establece por red la
// primera vez que se envía a ese grupo. Así la primera respuesta es tan rápida
// como las siguientes.
export const DEFAULT_MAX_PREWARM_GROUPS = 10;

export function groupsToPrewarm(targets = [], accountId, max = DEFAULT_MAX_PREWARM_GROUPS) {
  const result = [];
  const seen = new Set();

  for (const target of targets) {
    if (!target || target.accountId !== accountId) continue;
    if (!target.enabled || !target.groupJid) continue;
    if (seen.has(target.groupJid)) continue;

    seen.add(target.groupJid);
    result.push(target.groupJid);
    if (result.length >= max) break;
  }

  return result;
}
