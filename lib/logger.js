import { EventEmitter } from 'node:events';

const MAX_LOGS = 200;

const buffer = [];

// Emisor global: server.js lo escucha y reenvía cada entrada por Socket.IO.
export const logEvents = new EventEmitter();

export function addLog(level, message) {
  const entry = { level, message, ts: Date.now() };
  buffer.push(entry);
  if (buffer.length > MAX_LOGS) buffer.shift();
  console.log(`[${new Date(entry.ts).toLocaleTimeString('es-ES', { hour12: false })}] [${level}] ${message}`);
  logEvents.emit('log', entry);
}

export function getLogs() {
  return [...buffer];
}
