// Cola de tareas por chat (lógica pura, sin dependencias de Baileys).
//
// Cada chat tiene su propia cola: la primera respuesta se ejecuta ya y las
// siguientes esperan en orden (hasta `maxPending`). Chats distintos avanzan en
// paralelo. Así no se descartan mensajes repetidos del mismo contacto.
export const DEFAULT_MAX_PENDING_PER_CHAT = 3;

export class QueueFullError extends Error {
  constructor(jid) {
    super(`La cola del chat ${jid} está llena.`);
    this.name = 'QueueFullError';
    this.code = 'QUEUE_FULL';
    this.jid = jid;
  }
}

export function createChatQueues({ maxPending = DEFAULT_MAX_PENDING_PER_CHAT } = {}) {
  const queues = new Map(); // jid -> { running, pending: [] }

  function stateFor(jid) {
    let state = queues.get(jid);
    if (!state) {
      state = { running: false, pending: [] };
      queues.set(jid, state);
    }
    return state;
  }

  function cleanup(jid, state) {
    if (!state.running && state.pending.length === 0) queues.delete(jid);
  }

  async function execute(jid, state, entry) {
    try {
      entry.resolve(await entry.task());
    } catch (error) {
      entry.reject(error);
    }
    const next = state.pending.shift();
    if (next) {
      await execute(jid, state, next);
      return;
    }
    state.running = false;
    cleanup(jid, state);
  }

  // Ejecuta la tarea ya si el chat está libre; si no, la encola en orden.
  // Devuelve una promesa que se resuelve cuando la tarea termina (o rechaza
  // con QueueFullError si la cola estaba llena).
  function run(jid, task) {
    const state = stateFor(jid);
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject };
      if (!state.running) {
        state.running = true;
        void execute(jid, state, entry);
      } else if (state.pending.length < maxPending) {
        state.pending.push(entry);
      } else {
        reject(new QueueFullError(jid));
      }
    });
  }

  function isBusy(jid) {
    const state = queues.get(jid);
    return Boolean(state && (state.running || state.pending.length > 0));
  }

  function pendingCount(jid) {
    return queues.get(jid)?.pending.length ?? 0;
  }

  return { run, isBusy, pendingCount };
}
