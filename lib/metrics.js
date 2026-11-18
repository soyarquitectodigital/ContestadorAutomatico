// Seguimiento de latencia y eventos del bot.
//
// Usa una base SQLite aparte (DATA_DIR/metrics.db) para no competir con la
// sesión de WhatsApp ni con la configuración. Las escrituras se agrupan en
// memoria y se vuelcan cada segundo: registrar una métrica NUNCA debe bloquear
// el envío de una respuesta.
//
// message_events guarda solo los mensajes relevantes: respuestas, descartes de
// candidatos y errores. El ruido del grupo (mensajes sin relación) no se guarda
// para que la base siga siendo rápida y fácil de leer.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { addLog } from './logger.js';

const FLUSH_INTERVAL_MS = 1000;
const MAX_BUFFER = 500;
const MAX_PENDING = 5000;
const SUMMARY_LIMIT = 3000;
const RETENTION_DAYS = Math.max(1, Number(process.env.METRICS_RETENTION_DAYS) || 14);

const OUTCOMES = [
  'replied',
  'dropped_age',
  'queue_full',
  'disabled',
  'other_group',
  'no_keyword',
  'keyword_unregistered',
  'not_target',
  'other_account',
  'humanize_skip',
  'error',
];

const SYSTEM_EVENTS = [
  'connected',
  'closed',
  'reconnecting',
  'qr',
  'logged_out',
  'prewarm',
  'prewarm_group',
  'stopped',
  'removed',
  'error',
];

let client = null;
let enabled = false;
let pending = [];
let flushTimer = null;
let flushing = false;
let lastFlushErrorAt = 0;

export function metricsPath() {
  return (process.env.METRICS_PATH ?? '').trim() || path.join(dataDir(), 'metrics.db');
}

function textOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.max(min, number));
}

function cleanValues(values = []) {
  return values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
}

export function percentile(values, p) {
  const clean = cleanValues(values);
  if (clean.length === 0) return null;
  const rank = Math.ceil((p / 100) * clean.length) - 1;
  return clean[Math.max(0, Math.min(clean.length - 1, rank))];
}

export function summarize(values = []) {
  const clean = cleanValues(values);
  if (clean.length === 0) {
    return { count: 0, p50: null, p95: null, avg: null, max: null };
  }
  const rank = (p) => {
    const index = Math.ceil((p / 100) * clean.length) - 1;
    return clean[Math.max(0, Math.min(clean.length - 1, index))];
  };
  return {
    count: clean.length,
    p50: rank(50),
    p95: rank(95),
    avg: Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length),
    max: clean[clean.length - 1],
  };
}

function emptySummary(hours = 24, since = Date.now()) {
  return {
    enabled: false,
    hours,
    since,
    until: Date.now(),
    counts: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])),
    latency: {
      inbound: summarize([]),
      queue: summarize([]),
      send: summarize([]),
      total: summarize([]),
      ack: summarize([]),
    },
    cache: { hit: 0, miss: 0 },
    system: { counts: Object.fromEntries(SYSTEM_EVENTS.map((event) => [event, 0])), recent: [] },
    accounts: [],
    recent: [],
  };
}

export async function initMetrics({ filePath = metricsPath() } = {}) {
  if (enabled) return true;

  try {
    const rawPath = filePath.startsWith('file:') ? filePath.slice('file:'.length) : filePath;
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    const url = `file:${rawPath.replaceAll('\\', '/')}`;
    const { createClient } = await import('@libsql/client/node');
    client = createClient({ url });

    await client.batch(
      [
        `CREATE TABLE IF NOT EXISTS message_events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ts INTEGER NOT NULL,
           account_id TEXT NOT NULL,
           account_label TEXT,
           message_id TEXT,
           source_message_id TEXT,
           chat_jid TEXT,
           target_id TEXT,
           target_label TEXT,
           keyword TEXT,
           inbound_ms INTEGER,
           queue_ms INTEGER,
           send_ms INTEGER,
           total_ms INTEGER,
           ack_ms INTEGER,
           ack_status INTEGER,
           cache TEXT,
           outcome TEXT NOT NULL,
           reason TEXT,
           detail TEXT
         )`,
        `CREATE INDEX IF NOT EXISTS idx_message_events_ts ON message_events(ts)`,
        `CREATE INDEX IF NOT EXISTS idx_message_events_account_ts ON message_events(account_id, ts)`,
        `CREATE INDEX IF NOT EXISTS idx_message_events_message_id ON message_events(message_id)`,
        `CREATE INDEX IF NOT EXISTS idx_message_events_outcome_ts ON message_events(outcome, ts)`,
        `CREATE TABLE IF NOT EXISTS system_events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ts INTEGER NOT NULL,
           account_id TEXT,
           account_label TEXT,
           event TEXT NOT NULL,
           level TEXT,
           detail TEXT,
           duration_ms INTEGER,
           code INTEGER
         )`,
        `CREATE INDEX IF NOT EXISTS idx_system_events_ts ON system_events(ts)`,
        `CREATE INDEX IF NOT EXISTS idx_system_events_account_ts ON system_events(account_id, ts)`,
      ],
      'write',
    );

    enabled = true;
    addLog('info', `Métricas locales activadas: ${filePath}`);
    void cleanupOldMetrics();
    const timer = setInterval(() => void cleanupOldMetrics(), 24 * 60 * 60 * 1000);
    timer.unref?.();
    return true;
  } catch (error) {
    client = null;
    enabled = false;
    addLog('warn', `No se pudieron iniciar las métricas: ${error?.message ?? error}`);
    return false;
  }
}

function reportFlushError(error) {
  const now = Date.now();
  if (now - lastFlushErrorAt < 60_000) return;
  lastFlushErrorAt = now;
  addLog('warn', `Métricas: no se pudo guardar el lote (${error?.message ?? error}).`);
}

function pushEvent(event) {
  if (!enabled) return;
  pending.push(event);
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushMetrics();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

export function recordMessageEvent(event = {}) {
  pushEvent({
    kind: 'message',
    ts: Number(event.ts) || Date.now(),
    accountId: String(event.accountId ?? ''),
    accountLabel: textOrNull(event.accountLabel),
    messageId: textOrNull(event.messageId),
    sourceMessageId: textOrNull(event.sourceMessageId),
    chatJid: textOrNull(event.chatJid),
    targetId: textOrNull(event.targetId),
    targetLabel: textOrNull(event.targetLabel),
    keyword: textOrNull(event.keyword),
    inboundMs: numberOrNull(event.inboundMs),
    queueMs: numberOrNull(event.queueMs),
    sendMs: numberOrNull(event.sendMs),
    totalMs: numberOrNull(event.totalMs),
    ackMs: numberOrNull(event.ackMs),
    ackStatus: numberOrNull(event.ackStatus),
    cache: textOrNull(event.cache),
    outcome: textOrNull(event.outcome) ?? 'error',
    reason: textOrNull(event.reason),
    detail: textOrNull(event.detail),
  });
}

export function recordAck({ accountId, messageId, status, ackMs } = {}) {
  if (!messageId) return;
  pushEvent({
    kind: 'ack',
    accountId: String(accountId ?? ''),
    messageId: String(messageId),
    status: numberOrNull(status),
    ackMs: numberOrNull(ackMs),
  });
}

export function recordSystemEvent(event = {}) {
  pushEvent({
    kind: 'system',
    ts: Number(event.ts) || Date.now(),
    accountId: textOrNull(event.accountId),
    accountLabel: textOrNull(event.accountLabel),
    event: textOrNull(event.event) ?? 'event',
    level: textOrNull(event.level) ?? 'info',
    detail: textOrNull(event.detail),
    durationMs: numberOrNull(event.durationMs),
    code: numberOrNull(event.code),
  });
}

function toStatement(event) {
  if (event.kind === 'message') {
    return {
      sql: `INSERT INTO message_events (
              ts, account_id, account_label, message_id, source_message_id, chat_jid,
              target_id, target_label, keyword, inbound_ms, queue_ms, send_ms, total_ms,
              ack_ms, ack_status, cache, outcome, reason, detail
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        event.ts,
        event.accountId,
        event.accountLabel,
        event.messageId,
        event.sourceMessageId,
        event.chatJid,
        event.targetId,
        event.targetLabel,
        event.keyword,
        event.inboundMs,
        event.queueMs,
        event.sendMs,
        event.totalMs,
        event.ackMs,
        event.ackStatus,
        event.cache,
        event.outcome,
        event.reason,
        event.detail,
      ],
    };
  }

  if (event.kind === 'ack') {
    return {
      sql: 'UPDATE message_events SET ack_ms = ?, ack_status = ? WHERE message_id = ? AND account_id = ?',
      args: [event.ackMs, event.status, event.messageId, event.accountId],
    };
  }

  if (event.kind === 'system') {
    return {
      sql: `INSERT INTO system_events (ts, account_id, account_label, event, level, detail, duration_ms, code)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        event.ts,
        event.accountId,
        event.accountLabel,
        event.event,
        event.level,
        event.detail,
        event.durationMs,
        event.code,
      ],
    };
  }

  return null;
}

export async function flushMetrics() {
  if (!enabled || flushing) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.length === 0) return;

  flushing = true;
  try {
    while (pending.length > 0) {
      const batch = pending.splice(0, MAX_BUFFER);
      const statements = batch.map(toStatement).filter(Boolean);
      if (statements.length === 0) continue;

      try {
        await client.batch(statements, 'write');
      } catch (error) {
        // Un reintento corto: si la base está ocupada, no perdemos el lote.
        try {
          await new Promise((resolve) => setTimeout(resolve, 500));
          await client.batch(statements, 'write');
        } catch (retryError) {
          reportFlushError(retryError);
        }
      }
    }
  } finally {
    flushing = false;
    if (pending.length > 0) scheduleFlush();
  }
}

async function cleanupOldMetrics() {
  if (!enabled || !client) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    await client.batch(
      [
        { sql: 'DELETE FROM message_events WHERE ts < ?', args: [cutoff] },
        { sql: 'DELETE FROM system_events WHERE ts < ?', args: [cutoff] },
      ],
      'write',
    );
  } catch (error) {
    reportFlushError(error);
  }
}

function rowToEvent(row) {
  return {
    ts: Number(row.ts),
    accountId: row.account_id ?? null,
    accountLabel: row.account_label ?? null,
    targetLabel: row.target_label ?? null,
    keyword: row.keyword ?? null,
    inboundMs: numberOrNull(row.inbound_ms),
    queueMs: numberOrNull(row.queue_ms),
    sendMs: numberOrNull(row.send_ms),
    totalMs: numberOrNull(row.total_ms),
    ackMs: numberOrNull(row.ack_ms),
    ackStatus: numberOrNull(row.ack_status),
    cache: row.cache ?? null,
    outcome: row.outcome ?? null,
    reason: row.reason ?? null,
    detail: row.detail ?? null,
  };
}

export async function getMetricsSummary({ hours = 24, accountId = null, limit = SUMMARY_LIMIT } = {}) {
  const windowHours = clamp(hours, 1, 168, 24);
  const since = Date.now() - windowHours * 60 * 60 * 1000;
  if (!enabled || !client) return emptySummary(windowHours, since);

  const filter = accountId ? 'AND account_id = ?' : '';
  const baseArgs = accountId ? [since, accountId] : [since];

  const [countResult, repliedResult, recentResult, systemCountResult, systemRecentResult, accountResult] =
    await Promise.all([
      client.execute({
        sql: `SELECT outcome, COUNT(*) AS n FROM message_events WHERE ts >= ? ${filter} GROUP BY outcome`,
        args: baseArgs,
      }),
      client.execute({
        sql: `SELECT account_id, account_label, target_label, keyword, inbound_ms, queue_ms, send_ms, total_ms,
                     ack_ms, ack_status, cache, ts
              FROM message_events
              WHERE ts >= ? AND outcome = 'replied' ${filter}
              ORDER BY ts DESC LIMIT ?`,
        args: [...baseArgs, clamp(limit, 1, SUMMARY_LIMIT, SUMMARY_LIMIT)],
      }),
      client.execute({
        sql: `SELECT ts, account_id, account_label, target_label, keyword, inbound_ms, queue_ms, send_ms,
                     total_ms, ack_ms, ack_status, cache, outcome, reason, detail
              FROM message_events
              WHERE ts >= ? ${filter}
              ORDER BY ts DESC LIMIT 50`,
        args: baseArgs,
      }),
      client.execute({
        sql: `SELECT event, COUNT(*) AS n FROM system_events WHERE ts >= ? ${filter} GROUP BY event`,
        args: baseArgs,
      }),
      client.execute({
        sql: `SELECT ts, account_id, account_label, event, level, detail, duration_ms, code
              FROM system_events
              WHERE ts >= ? ${filter}
              ORDER BY ts DESC LIMIT 30`,
        args: baseArgs,
      }),
      client.execute({
        sql: `SELECT account_id, account_label, outcome, COUNT(*) AS n
              FROM message_events
              WHERE ts >= ? ${filter}
              GROUP BY account_id, account_label, outcome`,
        args: baseArgs,
      }),
    ]);

  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  for (const row of countResult.rows) counts[row.outcome] = Number(row.n);

  const replied = repliedResult.rows;
  const latency = {
    inbound: summarize(replied.map((row) => row.inbound_ms)),
    queue: summarize(replied.map((row) => row.queue_ms)),
    send: summarize(replied.map((row) => row.send_ms)),
    total: summarize(replied.map((row) => row.total_ms)),
    ack: summarize(replied.map((row) => row.ack_ms)),
  };

  const cache = {
    hit: replied.filter((row) => row.cache === 'hit').length,
    miss: replied.filter((row) => row.cache === 'miss').length,
  };

  const systemCounts = Object.fromEntries(SYSTEM_EVENTS.map((event) => [event, 0]));
  for (const row of systemCountResult.rows) systemCounts[row.event] = Number(row.n);

  const byAccount = new Map();
  for (const row of accountResult.rows) {
    const id = row.account_id;
    if (!byAccount.has(id)) {
      byAccount.set(id, {
        accountId: id,
        accountLabel: row.account_label ?? null,
        counts: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])),
        latencies: { inbound: [], queue: [], send: [], total: [], ack: [] },
      });
    }
    byAccount.get(id).counts[row.outcome] = Number(row.n);
  }
  for (const row of replied) {
    const entry = byAccount.get(row.account_id);
    if (!entry) continue;
    for (const key of ['inbound', 'queue', 'send', 'total', 'ack']) {
      const value = numberOrNull(row[`${key}_ms`]);
      if (value !== null) entry.latencies[key].push(value);
    }
  }

  const accounts = [...byAccount.values()].map((entry) => ({
    accountId: entry.accountId,
    accountLabel: entry.accountLabel,
    counts: entry.counts,
    latency: {
      inbound: summarize(entry.latencies.inbound),
      queue: summarize(entry.latencies.queue),
      send: summarize(entry.latencies.send),
      total: summarize(entry.latencies.total),
      ack: summarize(entry.latencies.ack),
    },
  }));

  return {
    enabled: true,
    hours: windowHours,
    since,
    until: Date.now(),
    counts,
    latency,
    cache,
    system: {
      counts: systemCounts,
      recent: systemRecentResult.rows.map((row) => ({
        ts: Number(row.ts),
        accountId: row.account_id ?? null,
        accountLabel: row.account_label ?? null,
        event: row.event,
        level: row.level ?? 'info',
        detail: row.detail ?? null,
        durationMs: numberOrNull(row.duration_ms),
        code: numberOrNull(row.code),
      })),
    },
    accounts,
    recent: recentResult.rows.map(rowToEvent),
  };
}

export async function getMetricsEvents({ hours = 24, accountId = null, outcome = null, limit = 100 } = {}) {
  if (!enabled || !client) return [];
  const windowHours = clamp(hours, 1, 168, 24);
  const since = Date.now() - windowHours * 60 * 60 * 1000;
  const where = ['ts >= ?'];
  const args = [since];
  if (accountId) {
    where.push('account_id = ?');
    args.push(accountId);
  }
  if (outcome) {
    where.push('outcome = ?');
    args.push(outcome);
  }
  args.push(clamp(limit, 1, 500, 100));

  const result = await client.execute({
    sql: `SELECT ts, account_id, account_label, target_label, keyword, inbound_ms, queue_ms, send_ms,
                 total_ms, ack_ms, ack_status, cache, outcome, reason, detail
          FROM message_events
          WHERE ${where.join(' AND ')}
          ORDER BY ts DESC LIMIT ?`,
    args,
  });
  return result.rows.map(rowToEvent);
}

export async function getSystemEvents({ hours = 24, accountId = null, limit = 100 } = {}) {
  if (!enabled || !client) return [];
  const windowHours = clamp(hours, 1, 168, 24);
  const since = Date.now() - windowHours * 60 * 60 * 1000;
  const where = ['ts >= ?'];
  const args = [since];
  if (accountId) {
    where.push('account_id = ?');
    args.push(accountId);
  }
  args.push(clamp(limit, 1, 500, 100));

  const result = await client.execute({
    sql: `SELECT ts, account_id, account_label, event, level, detail, duration_ms, code
          FROM system_events
          WHERE ${where.join(' AND ')}
          ORDER BY ts DESC LIMIT ?`,
    args,
  });
  return result.rows.map((row) => ({
    ts: Number(row.ts),
    accountId: row.account_id ?? null,
    accountLabel: row.account_label ?? null,
    event: row.event,
    level: row.level ?? 'info',
    detail: row.detail ?? null,
    durationMs: numberOrNull(row.duration_ms),
    code: numberOrNull(row.code),
  }));
}
