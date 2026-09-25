// Auto-ping para mantener despierto el servicio (Render plan free).
//
// Render suspende los servicios gratuitos tras ~15 minutos sin tráfico entrante.
// En lugar de depender de un ping externo (GitHub Actions, UptimeRobot...), la
// propia app se hace una petición HTTP a su URL pública cada pocos minutos. Esa
// petición sale y vuelve a entrar por el balanceador de Render, así que cuenta
// como tráfico entrante y el servicio no llega a dormirse.
//
// Limitación: el auto-ping evita que el servicio se duerma, pero NO puede
// despertarlo si ya está dormido. Tras un deploy o un reinicio manual hace
// falta una visita externa una sola vez; a partir de ahí la app se mantiene.
//
// Se activa solo cuando hay una URL pública disponible:
//   - SELF_PING_URL (o APP_URL) si se define explícitamente, o
//   - RENDER_EXTERNAL_URL, que Render inyecta automáticamente en cada servicio.
// En local o en la app de escritorio no hay URL pública y no se activa.
//
// El intervalo se ajusta con SELF_PING_INTERVAL_MINUTES (por defecto 10, mínimo 1).

import { addLog } from './logger.js';

export const DEFAULT_INTERVAL_MINUTES = 10;
export const PING_PATH = '/healthz';

// Lógica pura: decide la URL base pública según las variables de entorno.
export function resolveSelfPingUrl(env = process.env) {
  const raw = env.SELF_PING_URL || env.APP_URL || env.RENDER_EXTERNAL_URL || '';
  const url = String(raw).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(url)) return null;
  return url;
}

// Lógica pura: intervalo en milisegundos (por defecto 10 min, mínimo 1 min).
export function resolveIntervalMs(env = process.env) {
  const minutes = Number(env.SELF_PING_INTERVAL_MINUTES);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_INTERVAL_MINUTES * 60 * 1000;
  return Math.max(1, minutes) * 60 * 1000;
}

let timer = null;

// Devuelve true si el auto-ping quedó activo, false si no hay URL pública.
export function startSelfPing({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (timer) return true;
  const baseUrl = resolveSelfPingUrl(env);
  if (!baseUrl) return false;

  const intervalMs = resolveIntervalMs(env);
  const url = `${baseUrl}${PING_PATH}`;

  const ping = async () => {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Solo a consola (visible en los logs de Render); no se usa addLog para no
      // llenar el buffer del panel con una entrada cada pocos minutos.
      console.log(`[auto-ping] ${url} -> ${response.status}`);
    } catch (error) {
      addLog('warn', `Auto-ping fallido (${url}): ${error?.message ?? error}`);
    }
  };

  timer = setInterval(ping, intervalMs);
  timer.unref(); // no impedir el cierre ordenado del proceso
  addLog('info', `Auto-ping activado: ${url} cada ${Math.round(intervalMs / 60000)} min (mantiene despierto el servicio).`);
  void ping(); // primer ping inmediato para validar la URL al arrancar
  return true;
}

export function stopSelfPing() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
